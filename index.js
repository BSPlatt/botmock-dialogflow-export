(await import('dotenv')).config();
import * as utils from '@botmock-api/utils';
import camelcase from 'camelcase';
import mkdirp from 'mkdirp';
import chalk from 'chalk';
import Sema from 'async-sema';
import uuid from 'uuid/v4';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Provider } from './lib/providers';
import { SDKWrapper } from './lib/util/SDKWrapper';
import { getArgs, templates, SUPPORTED_PLATFORMS } from './lib/util';

process.on('unhandledRejection', err => {
  console.error(err);
  process.exit(1);
});

process.on('uncaughtException', err => {
  console.error(err);
  process.exit(1);
});

const mkdirpP = promisify(mkdirp);
const execP = promisify(exec);
const dim = str => void console.log(chalk.dim(str));
const bold = str => void console.log(chalk.bold(str));

const ZIP_PATH = `${process.cwd()}/output.zip`;
const INTENT_PATH = `${process.cwd()}/output/intents`;
const ENTITY_PATH = `${process.cwd()}/output/entities`;

await mkdirpP(INTENT_PATH);
await mkdirpP(ENTITY_PATH);

dim('initializing client');
// Boot up client with any args passed from command line
const client = new SDKWrapper(getArgs(process.argv));
client.on('error', err => {
  throw err;
});

let { platform, board, intents } = await client.init();
if (platform === 'google-actions') {
  platform = 'google';
}

const privilegedMessages = utils.createIntentMap(board.messages);
const collectIntermediateNodes = utils.getIntermediateNodes(
  privilegedMessages,
  getMessage
);
let semaphore;
try {
  dim('beginning write phase');
  semaphore = new Sema(os.cpus().length, { capacity: privilegedMessages.size });
  const provider = new Provider(platform);
  // Write intent and utterances files for each combination of message -> intent
  (async () => {
    for await (const [key, intentIds] of privilegedMessages.entries()) {
      await semaphore.acquire();
      const {
        message_type,
        payload,
        next_message_ids,
        previous_message_ids
      } = getMessage(key);
      for (const intent of intentIds) {
        const { name, updated_at, utterances } = intents.get(intent);
        const basename = `${name}_${camelcase(payload.nodeName)}`;
        const path = `${INTENT_PATH}/${basename}.json`;
        const intermediateNodes = collectIntermediateNodes(
          next_message_ids
        ).map(getMessage);
        // Write the intent file
        await fs.promises.writeFile(
          path,
          JSON.stringify({
            ...templates.intent,
            id: uuid(),
            name: basename,
            contexts: hasWelcomeIntent(key) ? [] : [intents.get(intent).name],
            events: hasWelcomeIntent(key) ? [{ name: 'WELCOME' }] : [],
            lastUpdate: Date.parse(updated_at.date),
            responses: [
              {
                action: '',
                speech: [],
                parameters: [],
                resetContexts: false,
                // Output contexts are the union of the intents emanated from
                // any intermediate nodes and those that emanate from _this_ node
                affectedContexts: [
                  ...intermediateNodes.reduce((acc, { next_message_ids }) => {
                    if (!next_message_ids.length) {
                      return acc;
                    }
                    return [
                      ...acc,
                      ...next_message_ids
                        .filter(({ intent }) => !!intent.value)
                        .map(({ intent: { value } }) => ({
                          name: intents.get(value).name,
                          parameters: {},
                          lifespan: 1
                        }))
                    ];
                  }, []),
                  ...next_message_ids
                    .filter(({ intent }) => !!intent.value)
                    .map(({ intent: { value } }) => ({
                      name: intents.get(value).name,
                      parameters: {},
                      lifespan: 1
                    }))
                ],
                defaultResponsePlatforms: SUPPORTED_PLATFORMS.has(
                  platform.toLowerCase()
                )
                  ? { [platform.toLowerCase()]: true }
                  : {},
                messages: [{ message_type, payload }, ...intermediateNodes].map(
                  message =>
                    provider.create(message.message_type, message.payload)
                )
              }
            ]
          })
        );
        // If we have utterances, write a file for them
        if (Array.isArray(utterances) && utterances.length) {
          await fs.promises.writeFile(
            `${path.slice(0, -5)}_usersays_en.json`,
            JSON.stringify(
              utterances.map(utterance => {
                const data = [];
                const pairs = utterance.variables.reduce(
                  (acc, vari) => ({
                    ...acc,
                    [vari.id]: [
                      vari.start_index,
                      vari.start_index + vari.name.length
                    ]
                  }),
                  {}
                );
                let lastIndex = 0;
                // Append `data` by iterating over the variable's occurances
                for (const [id, [start, end]] of Object.entries(pairs)) {
                  const previousBlock = [];
                  if (start !== lastIndex) {
                    previousBlock.push({
                      text: utterance.text.slice(lastIndex, start),
                      userDefined: false
                    });
                  }
                  const { name, entity } = utterance.variables.find(
                    vari => vari.id === id
                  );
                  data.push(
                    ...previousBlock.concat({
                      text: name.slice(1, -1),
                      meta: `@${entity}`,
                      userDefined: true
                    })
                  );
                  if (id !== Object.keys(pairs).pop()) {
                    lastIndex = end;
                  } else {
                    data.push({
                      text: utterance.text.slice(end),
                      userDefined: false
                    });
                  }
                }
                return {
                  id: uuid(),
                  data: data.length
                    ? data
                    : [{ text: utterance.text, userDefined: false }],
                  count: 0,
                  isTemplate: false,
                  updated: Date.parse(updated_at.date)
                };
              })
            )
          );
        }
      }
      semaphore.release();
    }
  })();
  dim('ending write phase');
  // Write entity files in one-to-one correspondence with original project
  for (const entity of await client.getEntities()) {
    await fs.promises.writeFile(
      `${ENTITY_PATH}/${entity.name}.json`,
      JSON.stringify({
        ...templates.entity,
        id: uuid(),
        name: entity.name
      })
    );
    await fs.promises.writeFile(
      `${ENTITY_PATH}/${entity.name}_entries_en.json`,
      JSON.stringify(entity.data)
    );
  }
  // Copy template files into output directory
  for (const filename of await fs.promises.readdir(`${__dirname}/templates`)) {
    if (filename.startsWith('intent') || filename.startsWith('entity')) {
      continue;
    }
    await fs.promises.copyFile(
      `${__dirname}/templates/${filename}`,
      `${__dirname}/output/${filename}`
    );
  }
  // Remove zip file if it exists; then zip and remove output dir
  try {
    await fs.promises.access(ZIP_PATH, fs.constants.F_OK);
    await fs.promises.unlink(ZIP_PATH);
  } catch (_) {
  } finally {
    dim('zipping output directory');
    await execP(`zip -r ${process.cwd()}/output.zip ${process.cwd()}/output`);
    await execP(`rm -rf ${process.cwd()}/output`);
  }
  bold('done');
} catch (err) {
  if (semaphore && semaphore.nrWaiting() > 0) {
    await semaphore.drain();
  }
  console.error(err.stack);
  process.exit(1);
}

// Gets the message with this id from the board
function getMessage(id) {
  return board.messages.find(m => m.message_id === id);
}

// Determines if `message` is the root
function messageIsRoot(message) {
  return board.root_messages.includes(message.message_id);
}

// Determines if `id` is the node adjacent to root with max number of connections
function hasWelcomeIntent(id) {
  const messages = privilegedMessages.size
    ? board.messages.filter(message =>
        privilegedMessages.has(message.message_id)
      )
    : board.messages;
  const [{ message_id }] = messages.sort(
    (a, b) =>
      b.previous_message_ids.filter(messageIsRoot).length -
      a.previous_message_ids.filter(messageIsRoot).length
  );
  return id === message_id;
}
