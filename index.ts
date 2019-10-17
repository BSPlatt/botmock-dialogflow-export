import "dotenv/config";
import * as Sentry from "@sentry/node";
import { RewriteFrames } from "@sentry/integrations";
import { writeJson, mkdirp, remove } from "fs-extra";
// import { zipSync } from "cross-zip";
import { join } from "path";
import { EOL } from "os";
import { default as SDKWrapper } from "./lib/sdk";
import { default as FileWriter } from "./lib/file";
import { default as log } from "./lib/log";
import { SENTRY_DSN } from "./lib/constants";
// @ts-ignore
import pkg from "./package.json";

declare global {
  namespace NodeJS {
    interface Global {
      __rootdir__: string;
    }
  }
}

global.__rootdir__ = __dirname || process.cwd();

Sentry.init({
  dsn: SENTRY_DSN,
  release: `${pkg.name}@${pkg.version}`,
  integrations: [new RewriteFrames({ root: global.__rootdir__ })],
  beforeSend(event): Sentry.Event {
    if (event.user.email) {
      delete event.user.email;
    }
    return event;
  }
});

interface Paths {
  readonly outputPath: string;
  readonly intentPath: string;
  readonly entityPath: string;
}

/**
 * Removes and then creates the directories that hold generated files
 * @param paths object containing paths to directories that will hold files
 * generated by the script
 * @returns Promise<void>
 */
async function recreateOutputDirectories(paths: Paths): Promise<void> {
  const { outputPath, intentPath, entityPath } = paths;
  await remove(outputPath);
  await mkdirp(intentPath);
  await mkdirp(entityPath);
}

/**
 * Calls all fetch methods and calls all write methods
 * @param args string[]
 * @returns Promise<void>
 */
async function main(args: string[]): Promise<void> {
  const DEFAULT_OUTPUT = "output";
  let [, , outputDirectory] = args;
  if (typeof outputDirectory === "undefined") {
    outputDirectory = process.env.OUTPUT_DIR || DEFAULT_OUTPUT;
  }
  const INTENT_PATH = join(outputDirectory, "intents");
  const ENTITY_PATH = join(outputDirectory, "entities");
  log("creating output directories");
  await recreateOutputDirectories({
    outputPath: outputDirectory,
    intentPath: INTENT_PATH,
    entityPath: ENTITY_PATH
  });
  log("fetching project data");
  const { data: projectData } = await new SDKWrapper({
    token: process.env.BOTMOCK_TOKEN, 
    teamId: process.env.BOTMOCK_TEAM_ID,
    projectId: process.env.BOTMOCK_PROJECT_ID,
    boardId: process.env.BOTMOCK_BOARD_ID,
  }).fetch();
  log("writing files");
  await new FileWriter({ outputDirectory, projectData }).write();
  // zipSync(outputDirectory, `${outputDirectory}.zip`);
  log("done");
}

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

main(process.argv).catch(async (err: Error) => {
  log(err.stack, { hasError: true });
  if (process.env.OPT_IN_ERROR_REPORTING) {
    Sentry.captureException(err);
  } else {
    const { message, stack } = err;
    await writeJson(join(__dirname, "err.json"), { message, stack }, { EOL, spaces: 2 });
  }
});
