'use strict';

const Jimp = require('jimp');
const invariant = require('invariant');
const mergeWith = require('lodash.mergewith');
const createClient = require('@mailupinc/bee-emailonacid-client');
const getConfig = require('./get-config');
const createLogger = require('./create-logger');
const getConfigDefaults = require('./get-config-defaults');
const createResultStream = require('./create-result-stream');
const { OutputType } = require('./config');

function configureCreateEmail(configuredOptions = {}) {
  // Merge all given options, but replace list of clients instead of concat
  const defaultOptions = getConfigDefaults();
  const globalOptions = getConfig();
  const customMerge = (_, right, key) =>
    ['clients', 'plugins'].includes(key) ? right : undefined;
  const options = mergeWith(
    {},
    defaultOptions,
    globalOptions,
    configuredOptions,
    customMerge
  );
  const logger = createLogger(options);
  logger.debug('using clients %s', options.clients.join(', '));
  logger.debug(
    'using plugins %s',
    options.plugins.map((plugin) => plugin.name).join(', ')
  );
  let client;

  return async function createEmail(content, subject = 'Mail Snapshot') {
    // Lazy-load client
    if (!client) {
      logger.debug('creating EoA client');
      client = createClient({
        apiKey: options.credentials.apiKey,
        accountPassword: options.credentials.accountPassword,
        defaultClients: options.clients,
        baseApiUrl: options.server,
      });
    }
    // Validate desired clients as some are might be missing atm
    logger.time('create');
    logger.debug('creating new email');
    const availableClients = await client.getClients();
    const availableClientIds = availableClients.map(({ id }) => id);
    const [knownClients, unknownClients] = options.clients.reduce(
      ([known, unknown], clientId) => {
        if (availableClientIds.includes(clientId)) {
          known.push(clientId);
        } else {
          unknown.push(clientId);
        }
        return [known, unknown];
      },
      [[], []]
    );
    // Notify and update list of clients if needed
    if (unknownClients.length) {
      const error = new Error();
      error.message = `Skipping unknown or temporarily unavailable clients ${unknownClients}`;
      error.clients = unknownClients;
      logger.error(error);
    }
    if (process.env.EOA_CLIENTS) process.env.EOA_CLIENTS = String(knownClients);
    // eslint-disable-next-line require-atomic-updates
    options.clients = knownClients;
    // Remove cropper plugin if only LINK output is selected
    if (!options.outputType.includes(OutputType.BUFFER)) {
      options.plugins = options.plugins.filter(
        (plugin) => plugin.name !== 'ContentCroppingPlugin'
      );
    }
    // Run `prepare` plugins
    const email = { content, subject };
    const context = { logger, client, email, options };
    for (const plugin of options.plugins) {
      if (plugin.prepare) {
        await plugin.prepare(context);
      }
    }
    // Create a new test on EoA side and poll the results
    logger.debug('creating an EoA test');
    // eslint-disable-next-line require-atomic-updates
    context.test = await client.createTest({
      html: context.email.content,
      subject: context.email.subject,
    });
    // eslint-disable-next-line require-atomic-updates
    context.stream = createResultStream(context, options);
    // eslint-disable-next-line require-atomic-updates
    context.stopPolling = context.stream.stopPolling.bind(context.stream);
    // Track complete result timings
    options.clients.forEach((clientId) =>
      logger.time(`screenshot:${clientId}`)
    );
    // Run `process` plugins
    for (const plugin of options.plugins) {
      if (plugin.convert) {
        await plugin.convert(context);
      }
    }
    // Convert results to a map of promises
    const results = options.clients.reduce((map, clientId) => {
      return map.set(
        clientId,
        new Promise((resolve, reject) => {
          context.stream.on('data', ([receivedClientId, image, src]) => {
            if (clientId === receivedClientId) resolve({ image, src });
          });
          context.stream.on('error', reject);
          context.stream.on('close', () => reject('stream closed'));
        })
      );
    }, new Map());
    logger.timeEnd('create');

    return {
      get id() {
        return context.test.id;
      },
      get clients() {
        return options.clients;
      },
      get subject() {
        return context.email.subject;
      },
      get content() {
        return context.email.content;
      },
      async screenshot(clientId) {
        invariant(
          options.clients.includes(clientId),
          '`.screenshot()` is called for an unavailable client %s',
          clientId
        );
        const { image, src } = await results.get(clientId);
        const result = await image?.getBufferAsync(Jimp.MIME_PNG);
        logger.timeEnd(`screenshot:${clientId}`);
        return { stream: result, link: src };
      },
      async clean() {
        logger.time('clean');
        await context.stopPolling();
        await client.deleteTest(context.test.id);
        logger.timeEnd('clean');
      },
    };
  };
}

module.exports = configureCreateEmail;
