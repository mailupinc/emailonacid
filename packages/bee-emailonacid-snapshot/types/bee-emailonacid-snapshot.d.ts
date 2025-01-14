import { Signale } from 'signale';
import { Readable } from 'stream';
import { Client, ClientId, TestId } from '@mailupinc/bee-emailonacid-client';

export interface Context {
  options: Config;
  logger: Signale;
  client: Client;
  email: {
    subject: string;
    content: string;
  };
  test?: {
    id: TestId;
  };
  stream?: Readable;
  stopPolling?: () => Promise<void>;
}

export interface Results {
  stream?: Buffer;
  link?: URL;
}

export interface Plugin {
  prepare(context: Context): any;
  convert(context: Context): any;
}

export enum OutputType {
  BUFFER = 0,
  LINK = 1,
}

export interface Config {
  credentials: {
    apiKey: string;
    accountPassword: string;
  };
  clients?: Array<ClientId>;
  plugins?: Array<Plugin>;
  debug?: boolean;
  poll?: {
    interval?: number;
    timeout?: number;
  };
  server?: string;
  outputType?: Array<OutputType>;
}

export interface Email<T> {
  id: TestId;
  subject: string;
  content: string;
  clients: Array<ClientId>;
  screenshot(clientId: ClientId): Promise<Results>;
  clean(): Promise<boolean>;
}

export function createEmail<T>(content: T, subject?: string): Email<T>;
export function configureCreateEmail(options?: Config): typeof createEmail;
export function withOverridableClients(config: Config): Config;
export function withDefaultPlugins(config: Config): Config;
