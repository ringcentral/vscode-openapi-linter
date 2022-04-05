import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import {
  TextDocument
} from 'vscode-languageserver-textdocument';
import {Spectral, Document} from '@stoplight/spectral-core';
import {Yaml} from '@stoplight/spectral-parsers';
import * as fs from 'fs';
import {join} from 'path';
import { bundleAndLoadRuleset } from "@stoplight/spectral-ruleset-bundler/dist/loader/node";

interface LinterSettings {
  spectralRulesetsFile: string;
}
const fakeFS: any = {
  promises: {
    async readFile(filepath: string) {
      if (filepath === '/.spectral-default.yaml') {
        return `extends: ["spectral:oas", "spectral:asyncapi"]`;
      }
      return fs.promises.readFile(filepath);
    },
  },
};
const spectral = new Spectral();
let initialized = false;
const loadConfig = async () => {
  let settings: LinterSettings;
  if(initialized) {
    const workspacePath = (await connection.workspace.getWorkspaceFolders())![0].uri;
    let spectralRulesetsFile = join(workspacePath, '.spectral.yml');
    if(spectralRulesetsFile.startsWith('file:')) {
      spectralRulesetsFile = spectralRulesetsFile.substring(5);
    }
    if(fs.existsSync(spectralRulesetsFile)){
      settings = {spectralRulesetsFile};
    } else {
      settings = await connection.workspace.getConfiguration('openApiLinter') as LinterSettings;
      if(!fs.existsSync(settings.spectralRulesetsFile ?? '')) {
        settings.spectralRulesetsFile = '/.spectral-default.yaml';
      }
    }
  } else {
    settings = {spectralRulesetsFile: '/.spectral-default.yaml'};
  }
  const customRules = await bundleAndLoadRuleset(settings.spectralRulesetsFile, {
    fs: fakeFS,
    fetch: globalThis.fetch,
  });
  spectral.setRuleset(customRules);
};
loadConfig();

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    }
  };
  return result;
});

connection.onInitialized(async () => {
  initialized = true;
  connection.client.register(DidChangeConfigurationNotification.type, undefined);
});

connection.onDidChangeConfiguration(async change => {
  await loadConfig();
  documents.all().forEach(validateTextDocument);
});

connection.onDidChangeWatchedFiles(async params => {
  loadConfig();
  documents.all().forEach(validateTextDocument);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  let diagnostics: Diagnostic[] = [];
  if(text.startsWith('openapi:')) {
    const issues = await spectral.run(new Document(text, Yaml, 'spec.yaml'));
    diagnostics = issues.map(issue => ({
      severity: issue.severity + 1,
      code: issue.code,
      range: issue.range,
      message: issue.message,
      source: 'OpenAPI Linter'
    })) as Diagnostic[];
  }
  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
