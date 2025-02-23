import { NextFunction, Request, RequestHandler, Response } from "express";
import {
  BadRequestError,
  InternalServerError,
  PayloadTooLargeError,
  ValidationError,
} from "../../../common/errors";
import {
  CheckedContract,
  CompilerOutput,
  InvalidSources,
  JsonInput,
  Match,
  Metadata,
  MissingSources,
  PathContent,
  Status,
  StringMap,
  checkFiles,
  isEmpty,
  useAllSources,
} from "@ethereum-sourcify/lib-sourcify";
import { Session } from "express-session";
import { AbiConstructor, AbiParameter } from "abitype";
import QueryString from "qs";
import fetch from "node-fetch";
import { IVerificationService } from "../../services/VerificationService";
import { IRepositoryService } from "../../services/RepositoryService";
import { ContractMeta, ContractWrapper, getMatchStatus } from "../../common";
import { auth } from "express-oauth2-jwt-bearer";
import rateLimit from "express-rate-limit";
import config from "../../../config";
import { id as keccak256str } from "ethers";
import { ForbiddenError } from "../../../common/errors/ForbiddenError";
import { UnauthorizedError } from "../../../common/errors/UnauthorizedError";
import { ISolidityCompiler } from "@ethereum-sourcify/lib-sourcify";
import { SolcLambda } from "../../services/compiler/lambda/SolcLambda";
import { SolcLocal } from "../../services/compiler/local/SolcLocal";

let selectedSolidityCompiler: ISolidityCompiler;
switch (process.env.SOLIDITY_COMPILER) {
  case "lambda": {
    selectedSolidityCompiler = new SolcLambda();
    break;
  }
  case "local":
  default: {
    selectedSolidityCompiler = new SolcLocal();
  }
}

export const solc = selectedSolidityCompiler;

export function createCheckedContract(
  metadata: Metadata,
  solidity: StringMap,
  missing?: MissingSources,
  invalid?: InvalidSources
) {
  return new CheckedContract(solc, metadata, solidity, missing, invalid);
}

type PathBuffer = {
  path: string;
  buffer: Buffer;
};

export type LegacyVerifyRequest = Request & {
  body: {
    addresses: string[];
    chain: string;
    chosenContract: number;
    /* contextVariables?: {
        abiEncodedConstructorArguments?: string;
        msgSender?: string;
      }; */
  };
};

export const extractFiles = (req: Request, shouldThrow = false) => {
  if (req.is("multipart/form-data") && (req.files as any)?.files) {
    return extractFilesFromForm((req.files as any).files);
  } else if (req.is("application/json") && req.body.files) {
    return extractFilesFromJSON(req.body.files);
  }

  if (shouldThrow) {
    throw new ValidationError("There should be files in the <files> field");
  }
};

const extractFilesFromForm = (files: any): PathBuffer[] => {
  if (!Array.isArray(files)) {
    files = [files];
  }
  return files.map((f: any) => ({ path: f.name, buffer: f.data }));
};

export const extractFilesFromJSON = (files: {
  [key: string]: string;
}): PathBuffer[] => {
  const inputFiles: PathBuffer[] = [];
  for (const name in files) {
    const file = files[name];
    const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
    inputFiles.push({ path: name, buffer });
  }
  return inputFiles;
};

export const stringifyInvalidAndMissing = (contract: CheckedContract) => {
  const errors = Object.keys(contract.invalid).concat(
    Object.keys(contract.missing)
  );
  return `${contract.name} (${errors.join(", ")})`;
};

export const FILE_ENCODING = "base64";
export const MAX_SESSION_SIZE = 50 * 1024 * 1024; // 50 MiB

export function generateId(obj: any): string {
  return keccak256str(JSON.stringify(obj));
}
export const saveFiles = (
  pathContents: PathContent[],
  session: Session
): number => {
  if (!session.inputFiles) {
    session.inputFiles = {};
  }

  let inputSize = 0; // shall contain old buffer size + new files size
  for (const id in session.inputFiles) {
    const pc = session.inputFiles[id];
    inputSize += pc.content.length;
  }

  pathContents.forEach((pc) => (inputSize += pc.content.length));

  if (inputSize > MAX_SESSION_SIZE) {
    const msg =
      "Too much session memory used. Delete some files or clear the session.";
    throw new PayloadTooLargeError(msg);
  }

  let newFilesCount = 0;
  pathContents.forEach((pc) => {
    const newId = generateId(pc.content);
    if (!(newId in session.inputFiles)) {
      session.inputFiles[newId] = pc;
      ++newFilesCount;
    }
  });

  return newFilesCount;
};

type Mutable<Type> = {
  -readonly [Key in keyof Type]: Type[Key];
};

// Contract object in the server response.
export type SendableContract = ContractMeta & {
  files: {
    found: string[];
    missing: MissingSources;
    invalid: InvalidSources;
  };
  verificationId: string;
  constructorArgumentsArray?: Mutable<AbiParameter[]>;
  creationBytecode?: string;
};

function getSendableContract(
  contractWrapper: ContractWrapper,
  verificationId: string
): SendableContract {
  const contract = contractWrapper.contract;

  return {
    verificationId,
    constructorArgumentsArray: (
      contract?.metadata?.output?.abi?.find(
        (abi) => abi.type === "constructor"
      ) as AbiConstructor
    )?.inputs as Mutable<AbiParameter[]>,
    creationBytecode: contract?.creationBytecode,
    compiledPath: contract.compiledPath,
    name: contract.name,
    address: contractWrapper.address,
    chainId: contractWrapper.chainId,
    files: {
      found: Object.keys(contract.solidity), // Source paths
      missing: contract.missing,
      invalid: contract.invalid,
    },
    status: contractWrapper.status || "error",
    statusMessage: contractWrapper.statusMessage,
    storageTimestamp: contractWrapper.storageTimestamp,
  };
}

export function getSessionJSON(session: Session) {
  const contractWrappers = session.contractWrappers || {};
  const contracts: SendableContract[] = [];
  for (const id in contractWrappers) {
    const sendableContract = getSendableContract(contractWrappers[id], id);
    contracts.push(sendableContract);
  }

  const files: string[] = [];
  for (const id in session.inputFiles) {
    files.push(session.inputFiles[id].path);
  }
  const unused = session.unusedSources || [];
  return { contracts, unused, files };
}

export interface ContractWrapperMap {
  [id: string]: ContractWrapper;
}

export function updateUnused(unused: string[], session: Session) {
  if (!session.unusedSources) {
    session.unusedSources = [];
  }
  session.unusedSources = unused;
}

export const checkContractsInSession = async (session: Session) => {
  const pathBuffers: PathBuffer[] = [];
  for (const id in session.inputFiles) {
    const pathContent = session.inputFiles[id];
    pathBuffers.push({
      path: pathContent.path,
      buffer: Buffer.from(pathContent.content, FILE_ENCODING),
    });
  }

  try {
    const unused: string[] = [];
    const contracts = await checkFiles(solc, pathBuffers, unused);

    const newPendingContracts: ContractWrapperMap = {};
    for (const contract of contracts) {
      newPendingContracts[generateId(JSON.stringify(contract.metadataRaw))] = {
        contract,
      };
    }

    session.contractWrappers ||= {};
    for (const newId in newPendingContracts) {
      const newContractWrapper = newPendingContracts[newId];
      const oldContractWrapper = session.contractWrappers[newId];
      if (oldContractWrapper) {
        for (const path in newContractWrapper.contract.solidity) {
          oldContractWrapper.contract.solidity[path] =
            newContractWrapper.contract.solidity[path];
          delete oldContractWrapper.contract.missing[path];
        }
        oldContractWrapper.contract.solidity =
          newContractWrapper.contract.solidity;
        oldContractWrapper.contract.missing =
          newContractWrapper.contract.missing;
      } else {
        session.contractWrappers[newId] = newContractWrapper;
      }
    }
    updateUnused(unused, session);
  } catch (error) {
    const paths = pathBuffers.map((pb) => pb.path);
    updateUnused(paths, session);
  }
};

export async function addRemoteFile(
  query: QueryString.ParsedQs
): Promise<PathBuffer[]> {
  if (typeof query.url !== "string") {
    throw new BadRequestError("Query url must be a string");
  }
  let res;
  try {
    res = await fetch(query.url);
  } catch (err) {
    throw new BadRequestError("Couldn't fetch from " + query.url);
  }
  if (!res.ok) throw new BadRequestError("Couldn't fetch from " + query.url);
  // Save with the fileName exists on server response header.
  const fileName =
    res.headers.get("Content-Disposition")?.split("filename=")[1] ||
    query.url.substring(query.url.lastIndexOf("/") + 1) ||
    "file";
  const buffer = await res.buffer();
  return [
    {
      path: fileName,
      buffer,
    },
  ];
}

export const checkAndFetchMissing = async (
  contract: CheckedContract
): Promise<void> => {
  if (!CheckedContract.isValid(contract)) {
    try {
      // Try to fetch missing files
      await CheckedContract.fetchMissing(contract);
    } catch (e) {
      // There's no need to throw inside fetchMissing if we're going to do an empty catch. This would cause not being able to catch other potential errors inside the function. TODO: Don't throw inside `fetchMissing` and remove the try/catch block.
      // Missing files are accessible from the contract.missingFiles array.
      // No need to throw an error
    }
  }
};

export function isVerifiable(contractWrapper: ContractWrapper) {
  const contract = contractWrapper.contract;
  return (
    isEmpty(contract.missing) &&
    isEmpty(contract.invalid) &&
    Boolean(contractWrapper.address) &&
    Boolean(contractWrapper.chainId)
  );
}

export const verifyContractsInSession = async (
  contractWrappers: ContractWrapperMap,
  session: Session,
  verificationService: IVerificationService,
  repositoryService: IRepositoryService
): Promise<void> => {
  for (const id in contractWrappers) {
    const contractWrapper = contractWrappers[id];

    // Check if contract is already verified
    if (Boolean(contractWrapper.address) && Boolean(contractWrapper.chainId)) {
      const found = repositoryService.checkByChainAndAddress(
        contractWrapper.address as string,
        contractWrapper.chainId as string
      );

      if (found.length) {
        contractWrapper.status = found[0].runtimeMatch || "error";
        contractWrapper.statusMessage = found[0].message;
        contractWrapper.storageTimestamp = found[0].storageTimestamp;
        continue;
      }
    }

    await checkAndFetchMissing(contractWrapper.contract);

    if (!isVerifiable(contractWrapper)) {
      continue;
    }

    const {
      address,
      chainId,
      contract,
      /* contextVariables, */ creatorTxHash,
    } = contractWrapper;

    // The session saves the CheckedContract as a simple object, so we need to reinstantiate it
    const checkedContract = createCheckedContract(
      contract.metadata,
      contract.solidity,
      contract.missing,
      contract.invalid
    );

    let match: Match;
    try {
      match = await verificationService.verifyDeployed(
        checkedContract,
        chainId as string,
        address as string,
        /* contextVariables, */
        creatorTxHash
      );
      // Send to verification again with all source files.
      if (match.runtimeMatch === "extra-file-input-bug") {
        // Session inputFiles are encoded base64. Why?
        const pathBufferInputFiles: PathBuffer[] = Object.values(
          session.inputFiles
        ).map((base64file) => ({
          path: base64file.path,
          buffer: Buffer.from(base64file.content, FILE_ENCODING),
        }));
        const checkedContractWithAllSources = createCheckedContract(
          contractWrapper.contract.metadata,
          contractWrapper.contract.solidity,
          contractWrapper.contract.missing,
          contractWrapper.contract.invalid
        );
        const contractWithAllSources = await useAllSources(
          checkedContractWithAllSources,
          pathBufferInputFiles
        );
        const tempMatch = await verificationService.verifyDeployed(
          contractWithAllSources,
          chainId as string,
          address as string
          /* contextVariables */
        );
        if (
          tempMatch.runtimeMatch === "perfect" ||
          tempMatch.runtimeMatch === "partial" ||
          tempMatch.creationMatch === "perfect" ||
          tempMatch.creationMatch === "partial"
        ) {
          match = tempMatch;
        }
      }
    } catch (error: any) {
      match = {
        chainId: contractWrapper.chainId as string,
        runtimeMatch: null,
        creationMatch: null,
        address: contractWrapper.address as string,
        message: error.message,
      };
    }

    contractWrapper.status = getMatchStatus(match) || "error";
    contractWrapper.statusMessage = match.message;
    contractWrapper.storageTimestamp = match.storageTimestamp;
    if (match.runtimeMatch || match.creationMatch) {
      await repositoryService.storeMatch(checkedContract, match);
    }
  }
};

export const jwtCheck = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUERBASEURL,
  tokenSigningAlg: process.env.AUTH0_TOKENSIGNINGALG || "RS256",
});

export const apiLimiter = (
  windowMs: number,
  max: number,
  errorMessage = "Too many requests, please try again later."
) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers,
    message: {
      error: errorMessage,
    },
    keyGenerator: (req: Request) => req.auth?.payload.sub as string,
  });

export const isAuth0EnabledUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userInfoRequest = await fetch(
    `${process.env.AUTH0_ISSUERBASEURL}/userinfo`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.auth?.token}`,
      },
    }
  );
  if (userInfoRequest.status === 401) {
    throw new UnauthorizedError();
  }
  try {
    const userInfo = await userInfoRequest.json();
    if (!userInfo.sub.includes("auth0")) {
      throw new UnauthorizedError();
    }
  } catch (e) {
    throw new UnauthorizedError();
  }
  next();
};

export const apiCheckPermission = (permission: string, errorMessage: string) =>
  function (req: Request, res: Response, next: NextFunction) {
    if (!(req.auth?.payload?.permissions as string)?.includes(permission)) {
      throw new ForbiddenError(errorMessage);
    }
    next();
  };
