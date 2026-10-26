'use strict';

const { createHash, randomBytes } = require('node:crypto');

// TREK runs a tool call as the signed-in user for its own checks but does not tell the plugin who that is, so the caller
// is the owner of the access code in their personal plugin setting. Only a hash of each code is stored.
const ACCESS_SETTING = 'mcp_access_code';
const CONNECT = 'Create an access code under "MCP access" in Fieldnotes, then paste it into the personal setting '
  + '"MCP access code" of the Fieldnotes plugin.';
const digest = (code) => createHash('sha256').update(code, 'utf8').digest('hex');
const as = (userId, body = {}, query = {}) => ({ user: { id: userId }, body, query });
const summary = (note) => ({ id: note.id, title: note.title, icon: note.icon ?? null, tags: note.tags, properties: note.properties,
  version: note.version, folder_id: note.folder_id ?? null, owner_id: note.owner_id, visibility: note.visibility,
  created_at: note.created_at, updated_at: note.updated_at });
const failure = (text) => ({ content: [{ type: 'text', text }], isError: true });

class ToolError extends Error {}
const refuse = (message) => { throw new ToolError(message); };

function createMcp({ fail, problemOf, handle, tripAction }) {
  async function access(input, ctx, userId) {
    if (input.action === 'status') {
      const [row] = await ctx.db.query('SELECT created_at FROM mcp_access_codes WHERE user_id = ?', userId);
      return { exists: Boolean(row), created_at: row?.created_at ?? null };
    }
    if (input.action === 'create') {
      // Returned once; replacing a code ends every client still using the old one.
      const code = `fn_${randomBytes(24).toString('base64url')}`; const now = new Date().toISOString();
      await ctx.db.exec(`INSERT INTO mcp_access_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at`, userId, digest(code), now);
      return { exists: true, created_at: now, code };
    }
    if (input.action === 'revoke') {
      await ctx.db.exec('DELETE FROM mcp_access_codes WHERE user_id = ?', userId);
      return { exists: false, created_at: null };
    }
    fail(400, 'Unknown action.');
  }

  async function caller(ctx) {
    if (Number.isSafeInteger(ctx.user?.id) && ctx.user.id > 0) return ctx.user.id;
    const code = await ctx.settings.get(ACCESS_SETTING);
    if (typeof code !== 'string' || !code.trim()) refuse(`No Fieldnotes access code is set. ${CONNECT}`);
    const [row] = code.length > 200 ? []
      : await ctx.db.query('SELECT user_id FROM mcp_access_codes WHERE code_hash = ?', digest(code.trim()));
    return row?.user_id ?? refuse(`The Fieldnotes access code is not valid; it may have been revoked or replaced. ${CONNECT}`);
  }

  // Each tool sends the request the page would send, so permissions, limits and version checks stay those of the routes.
  const personal = {
    async list_folders(args, ctx, userId) {
      if (args.trip_id === undefined) return { folders: await handle('folders', as(userId), ctx) };
      return { folders: await handle('trip', as(userId, { action: 'folders', trip_id: args.trip_id }), ctx) };
    },
    async list_notes(args, ctx, userId) {
      const page = await handle('list', as(userId, {}, { q: args.q, offset: args.offset, folder_id: args.folder_id, sort: args.sort,
        order: args.order }), ctx);
      const next = page.has_more ? { next_offset: (args.offset || 0) + page.notes.length } : {};
      return { notes: page.notes.map(summary), has_more: page.has_more, ...next };
    },
    read_note: (args, ctx, userId) => handle('read', as(userId, {}, { id: args.note_id }), ctx),
    create_folder(args, ctx, userId) {
      const folder = { name: args.name, parent_id: args.parent_id, icon: args.icon };
      if (args.trip_id === undefined) return handle('folder', as(userId, { ...folder, action: 'create' }), ctx);
      return handle('trip', as(userId, { ...folder, action: 'folder_create', trip_id: args.trip_id }), ctx);
    },
    async save_note(args, ctx, userId) {
      const fields = { title: args.title, content: args.content, properties: args.properties };
      if (args.note_id === undefined) return summary(await handle('save', as(userId, { ...fields, folder_id: args.folder_id }), ctx));
      if (!Number.isSafeInteger(args.version)) refuse('Updating a note needs the version that read_note returned.');
      if (args.folder_id !== undefined) refuse('folder_id applies only when creating a note.');
      return summary(await handle('save', as(userId, { ...fields, id: args.note_id, version: args.version }), ctx));
    },
    async add_note_to_trip(args, ctx, userId) {
      const folderId = args.trip_folder_id ?? null;
      // Checked before linking, so a wrong folder leaves no half-made link behind.
      if (folderId && !(await handle('trip', as(userId, { action: 'folders', trip_id: args.trip_id }), ctx))
        .some((folder) => folder.id === folderId)) fail(404, 'Folder not found.');
      await handle('link', as(userId, { note_id: args.note_id, trip_id: args.trip_id, mode: args.mode, day_id: args.day_id ?? null }), ctx);
      if (folderId) {
        await handle('trip', as(userId, { action: 'folder_move', trip_id: args.trip_id, note_id: args.note_id, folder_id: folderId }), ctx);
      }
      return { linked: true, note_id: args.note_id, trip_id: args.trip_id, mode: args.mode, day_id: args.day_id ?? null,
        trip_folder_id: folderId };
    },
  };
  const tools = ['list_trip_notes', ...Object.keys(personal)];

  async function callTool({ name, args }, ctx) {
    const input = args && typeof args === 'object' ? args : {};
    // Trip members read what is shared with a trip without a code, as before access codes existed.
    if (name === 'list_trip_notes') return tripAction({ trip_id: input.trip_id, action: 'list' }, ctx);
    if (!Object.hasOwn(personal, name)) return failure('Unknown tool.');
    try { return await personal[name](input, ctx, await caller(ctx)); }
    catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const problem = problemOf(error);
      if (!problem) throw error;
      if (problem.status === 409 && name === 'save_note') {
        return failure(`${problem.message} Call read_note for the current version and content, then save again.`);
      }
      return failure(problem.message);
    }
  }

  return { access, tools, callTool };
}

module.exports = { createMcp, ACCESS_SETTING };
