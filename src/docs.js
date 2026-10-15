export class GoogleDocs {
  constructor(rpc, documentId, cwd) { this.rpc = rpc; this.documentId = documentId; this.cwd = cwd; }

  async connect() {
    const result = await this.rpc.call('thread/start', {
      ephemeral: true, cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      config: { 'features.apps': true },
    });
    this.threadId = result.thread.id;
    const servers = await this.rpc.call('mcpServerStatus/list', {
      threadId: this.threadId, serverName: 'codex_apps', detail: 'toolsAndAuthOnly',
    });
    const server = servers.data?.find(s => s.name === 'codex_apps');
    this.tools = Object.keys(server?.tools || {});
    for (const name of ['google_drive.get_document', 'google_drive.batch_update_document']) {
      if (!this.tools.includes(name)) throw new Error('Google Drive is not connected to Codex. Enable the Google Drive plugin in ChatGPT/Codex, then restart docex.');
    }
  }

  async invoke(tool, args) {
    const result = await this.rpc.call('mcpServer/tool/call', {
      threadId: this.threadId, server: 'codex_apps', tool, arguments: args,
    });
    if (result.isError) throw new Error((result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') || `${tool} failed.`);
    if (result.structuredContent) return result.structuredContent;
    for (const part of result.content || []) {
      if (part.type === 'text') { try { return JSON.parse(part.text); } catch { /* Text diagnostics are not document resources. */ } }
    }
    throw new Error(`${tool} returned no structured result.`);
  }

  async read() {
    const doc = await this.invoke('google_drive.get_document', { document_id: this.documentId });
    if (doc.documentId !== this.documentId || !doc.revisionId) throw new Error('Google Docs returned an incomplete document or no editable revision.');
    return doc;
  }

  async batch(requests, revisionId) {
    if (!revisionId) throw new Error('Refusing to write without a document revision.');
    return this.invoke('google_drive.batch_update_document', {
      document_id: this.documentId, requests, write_control: { requiredRevisionId: revisionId },
    });
  }
}
