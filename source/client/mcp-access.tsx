import { useEffect, useRef, useState } from 'react';
import type { Translate } from './i18n';
import { Icon } from './icons';


type Access = { exists: boolean; created_at: string | null; code?: string };
type Post = <T>(path: string, body: unknown) => Promise<T>;

// The personal code MCP clients act with. The server keeps only its hash, so a new code is shown once, right after creation.
export function McpAccess({ t, locale, post, confirm, onClose }: {
  t: Translate; locale?: string; post: Post; onClose: () => void;
  confirm: (options: { message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const modal = useRef<HTMLElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(''); setStatus('');
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void run(async () => setAccess(await post<Access>('/mcp-access', { action: 'status' }))); }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusFirst = window.setTimeout(() => modal.current?.querySelector<HTMLElement>('button')?.focus(), 0);
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !modal.current) return;
      const focusable = Array.from(modal.current.querySelectorAll<HTMLElement>('button, input'))
        .filter((item) => !item.hasAttribute('disabled'));
      const next = focusable.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1);
      if (focusable.length && (next < 0 || next >= focusable.length)) {
        event.preventDefault(); focusable[(next + focusable.length) % focusable.length].focus();
      }
    };
    window.addEventListener('keydown', keys);
    return () => { window.clearTimeout(focusFirst); window.removeEventListener('keydown', keys); opener?.focus(); };
  }, []);

  const create = () => run(async () => {
    if (access?.exists && !await confirm({ danger: true, confirmLabel: t('Replace code', '更换访问码'),
      message: t('Replace the current code? MCP clients using it stop working until you paste the new one.',
        '更换当前访问码？使用旧访问码的 MCP 客户端会停止工作，直到你粘贴新的访问码。') })) return;
    setAccess(await post<Access>('/mcp-access', { action: 'create' }));
  });
  const revoke = () => run(async () => {
    if (!await confirm({ danger: true, confirmLabel: t('Revoke code', '撤销访问码'),
      message: t('Revoke the code? MCP clients using it stop working.', '撤销访问码？使用它的 MCP 客户端会停止工作。') })) return;
    setAccess(await post<Access>('/mcp-access', { action: 'revoke' })); setStatus(t('Code revoked.', '访问码已撤销。'));
  });
  async function copy() {
    if (!access?.code) return;
    try { await navigator.clipboard.writeText(access.code); setStatus(t('Copied.', '已复制。')); }
    catch { codeInput.current?.select(); setStatus(t('Select the code and copy it.', '请选中访问码并复制。')); }
  }
  const created = access?.created_at
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(access.created_at)) : '';

  return <div className="fn-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={modal} className="fn-modal trek-card fn-mcp-access" role="dialog" aria-modal="true" aria-labelledby="mcp-access-title"
      aria-busy={busy}>
      <header className="fn-modal-header">
        <h2 id="mcp-access-title">{t('MCP access', 'MCP 访问')}</h2>
        <button type="button" className="fn-modal-close" aria-label={t('Close', '关闭')} title={t('Close', '关闭')}
          onClick={onClose}><Icon name="close" /></button>
      </header>
      <p className="trek-muted">{t('Create a code, then paste it into the personal setting “MCP access code” of the Fieldnotes plugin. MCP clients connected to TREK as you can then read and write the notes you can access.',
      '创建访问码后，把它粘贴到 Fieldnotes 插件的个人设置“MCP access code”中。之后，以你的身份连接 TREK 的 MCP 客户端就能读写你有权访问的笔记。')}</p>
      {access && <p className="fn-mcp-access-state">{access.exists
        ? t('Created {date}', '创建于 {date}', { date: created }) : t('No access code yet.', '还没有访问码。')}</p>}
      {access?.code && <div className="fn-setting-field">
        <label className="trek-label" htmlFor="mcp-access-code">{t('Access code', '访问码')}</label>
        <div className="fn-mcp-access-code">
          <input id="mcp-access-code" ref={codeInput} className="trek-input" readOnly value={access.code}
            aria-describedby="mcp-access-once" onFocus={(event) => event.target.select()} />
          <button type="button" className="trek-btn trek-btn--secondary" onClick={() => void copy()}>{t('Copy', '复制')}</button>
        </div>
        <small id="mcp-access-once" className="trek-muted">
          {t('Copy this code now. It is shown only once.', '请立即复制此访问码，它只显示这一次。')}</small>
      </div>}
      {error && <div className="fn-error" role="alert">{error}</div>}
      <p className="fn-status trek-muted" role="status">{status}</p>
      {access && <div className="trek-cluster fn-mcp-access-actions">
        {access.exists && <button type="button" className="trek-btn trek-btn--ghost fn-danger-text" disabled={busy}
          onClick={() => void revoke()}>{t('Revoke code', '撤销访问码')}</button>}
        <button type="button" className="trek-btn trek-btn--primary" disabled={busy} onClick={() => void create()}>
          {access.exists ? t('Replace code', '更换访问码') : t('Create code', '创建访问码')}</button>
      </div>}
    </section>
  </div>;
}
