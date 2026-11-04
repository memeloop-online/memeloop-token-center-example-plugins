// Inline settings for the account supplied by the authenticated operator host.
const PLUGIN_ID = 'mtc-soonest-reset';
const scopePath = (path, tenant) => `${path}?${new URLSearchParams({ tenant_external_id: tenant })}`;
const copy = {
  zh: {
    title: '自动使用手动重置次数', toggle: '在手动重置次数到期前 10 分钟自动使用',
    help: '开启后，系统会检查此账号的可用次数与到期时间，在到期前 10 分钟内自动使用一次。关闭后停止后续自动使用，已提交的重置仍会继续核实。',
    loading: '正在读取自动使用设置…', saving: '正在保存…', readonly: '可查看当前设置。如需修改，请联系管理员。',
    enabled: '自动使用已开启', disabled: '自动使用已关闭', count: '可用次数', expiry: '最近到期时间', result: '最近结果',
    refresh: '刷新状态', refreshNeeded: '待刷新', none: '暂无可用次数', waiting: '等待自动检查',
    verify: '结果核实中', blocked: '已暂停，待检查', used: '已使用一次', verified: '已核实',
    unknown: '上次重置结果正在核实，可在当前账号查看重置记录。',
    accepted: '已提交一次重置，正在核实结果。',
    quotaUnavailable: '查看或刷新账号额度后可更新次数与到期时间。',
    permission: '请联系管理员开通此账号的设置权限，然后刷新状态。',
    conflict: '设置已被其他操作更新。请刷新状态后确认。',
    unavailable: '暂时无法读取自动使用设置，请联系管理员检查插件。',
    failure: '暂时无法读取设置，请刷新状态重试。',
    saveUnknown: '保存结果待确认。刷新状态查看最新设置。',
  },
  en: {
    title: 'Automatically use manual reset credits', toggle: 'Automatically use a manual reset credit in the last 10 minutes before expiry',
    help: 'Checks this account’s available credits and expiry, then uses one credit in the last 10 minutes before it expires. Turning this off stops future automatic resets; submitted resets will still be checked.',
    loading: 'Loading automatic reset settings…', saving: 'Saving…', readonly: 'You can view these settings. Contact an administrator to make changes.',
    enabled: 'Automatic use enabled', disabled: 'Automatic use disabled', count: 'Available credits', expiry: 'Next expiry', result: 'Latest result',
    refresh: 'Refresh status', refreshNeeded: 'Refresh needed', none: 'No available credits', waiting: 'Waiting for automatic check',
    verify: 'Verifying result', blocked: 'Paused; review required', used: 'One credit used', verified: 'Verified',
    unknown: 'The last reset result is being checked. View reset history in this account for updates.',
    accepted: 'One reset was submitted; its result is being checked.',
    quotaUnavailable: 'View or refresh account quota to update credits and expiry.',
    permission: 'Ask an administrator for access to these account settings, then refresh the status.',
    conflict: 'These settings changed elsewhere. Refresh the status and review them.',
    unavailable: 'Automatic reset settings are unavailable. Ask an administrator to check the plugin.',
    failure: 'Could not load settings. Refresh the status to retry.',
    saveUnknown: 'Save result unconfirmed. Refresh the status to see the latest settings.',
  },
};
const copyFor = locale => copy[locale?.startsWith('zh') ? 'zh' : 'en'];
const errorCopy = (error, c) => [401, 403].includes(error?.status) ? c.permission
  : error?.status === 409 ? c.conflict : error?.status === 404 ? c.unavailable : c.failure;

export function creditSummary(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.status !== 'ready' || snapshot.stale || snapshot.freshness !== 'fresh'
    || !Number.isFinite(snapshot.observed_at) || snapshot.observed_at > now
    || !Number.isFinite(snapshot.stale_after) || snapshot.stale_after <= now
    || snapshot.reset_capability?.credit_error_code) return { count: null, expiry: null, reliable: false };
  const credits = snapshot.reset_credits;
  const available = snapshot.reset_capability?.available_credits;
  if (!Array.isArray(credits)) return { count: null, expiry: null, reliable: false };
  const valid = credits.every(c => typeof c.status === 'string'
    && (c.status !== 'available' || (Number.isFinite(c.granted_at) && Number.isFinite(c.expires_at) && c.granted_at < c.expires_at)));
  if (!valid) return { count: null, expiry: null, reliable: false };
  const upcoming = credits.filter(c => c.status === 'available' && c.granted_at <= now && c.expires_at > now);
  return {
    count: Number.isFinite(available) ? available : upcoming.length,
    expiry: upcoming.length ? Math.min(...upcoming.map(c => c.expires_at)) : null,
    reliable: upcoming.length > 0 || available === 0,
  };
}

export function validateEnvelope(value, accountId, tenant) {
  if (!value || typeof value.can_write !== 'boolean' || !Object.hasOwn(value, 'grant')
    || !Object.hasOwn(value, 'operation')) throw new Error('Unsupported authorization response');
  const grant = value.grant;
  if (grant !== null && (grant.plugin_id !== PLUGIN_ID || grant.upstream_account_id !== accountId
    || grant.tenant_external_id !== tenant || typeof grant.enabled !== 'boolean'
    || !Number.isSafeInteger(grant.revision) || grant.revision < 0)) throw new Error('Authorization scope mismatch');
  const operation = value.operation;
  if (operation !== null && (operation.upstream_account_id !== accountId
    || !['prepared', 'submitted', 'accepted', 'unknown', 'expired'].includes(operation.state))) {
    throw new Error('Operation scope mismatch');
  }
  return value;
}

export function activateOperatorUi({ React, Fluent, defineOperatorUiPackage }) {
  const h = React.createElement;
  const stack = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, minWidth: 0, overflowWrap: 'anywhere' };
  const muted = { color: Fluent.tokens.colorNeutralForeground2 };
  function Notice({ intent = 'info', children }) {
    return h(Fluent.MessageBar, { intent, style: { minWidth: 0, overflowWrap: 'anywhere' } }, h(Fluent.MessageBarBody, null, children));
  }
  function AccountDetails({ account, api, tenant, locale, quotaSnapshot }) {
    const c = copyFor(locale);
    const [data, setData] = React.useState(null);
    const quota = quotaSnapshot?.contract_version === 'upstream_quota_v1' && quotaSnapshot.upstream_account_id === account.id
      && quotaSnapshot.tenant_external_id === tenant ? quotaSnapshot : null;
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const [saved, setSaved] = React.useState('');
    const [reload, setReload] = React.useState(0);
    const [now, setNow] = React.useState(Date.now);
    const alive = React.useRef(false);
    const generation = React.useRef(0);
    const writing = React.useRef(false);
    const base = scopePath(`/internal/v1/plugins/${PLUGIN_ID}/background-actions/${encodeURIComponent(account.id)}`, tenant);
    React.useEffect(() => {
      const controller = new AbortController();
      alive.current = true;
      generation.current += 1;
      setLoading(true); setData(null); setError('');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      api.requestApi({ path: base, signal }).then(value => {
        const checked = validateEnvelope(value, account.id, tenant);
        if (!controller.signal.aborted) setData(checked);
      }).catch(reason => { if (!controller.signal.aborted) setError(errorCopy(reason, c)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      return () => { alive.current = false; controller.abort(); };
    }, [api, base, account.id, tenant, reload]);
    React.useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 15_000);
      return () => clearInterval(timer);
    }, []);
    const grant = data?.grant;
    const enabled = grant?.enabled === true;
    const operation = data?.operation;
    const result = operation?.state ?? grant?.last_result;
    const blocked = grant?.last_result === 'blocked';
    const uncertain = ['unknown', 'submitted'].includes(result) && !operation?.settled_at;
    const needsVerification = uncertain || (result === 'accepted' && !operation?.settled_at);
    const currentTime = Math.max(now, Date.now());
    const summary = creditSummary(quota, currentTime);
    const fresh = quota && Number.isFinite(quota.stale_after) && quota.stale_after > currentTime;
    const expiry = fresh && summary.reliable ? summary.expiry : null;
    const date = value => Number.isFinite(value) ? new Date(value).toLocaleString(locale || 'zh-CN') : c.refreshNeeded;
    const outcome = needsVerification ? c.verify
      : blocked ? c.blocked
        : result === 'accepted' ? c.used
          : operation?.settled_at ? c.verified : c.waiting;
    async function toggle() {
      if (writing.current || !data?.can_write) return;
      writing.current = true; setSaving(true); setError(''); setSaved('');
      const expectedGeneration = generation.current;
      try {
        const value = await api.requestApi({
          path: base, method: 'PUT',
          body: { enabled: !enabled, expected_revision: grant?.revision ?? 0 },
          signal: AbortSignal.timeout(20_000),
        });
        const checked = validateEnvelope(value, account.id, tenant);
        if (alive.current && generation.current === expectedGeneration) {
          setData(checked);
          setSaved(checked.grant?.enabled ? c.enabled : c.disabled);
        }
      } catch (reason) {
        if (alive.current && generation.current === expectedGeneration) { setData(null); setError([401, 403, 409].includes(reason?.status) ? errorCopy(reason, c) : c.saveUnknown); }
      } finally {
        writing.current = false;
        if (alive.current && generation.current === expectedGeneration) setSaving(false);
      }
    }
    return h('div', { style: stack, 'aria-label': c.title, 'aria-busy': loading || saving, 'data-account-reset-settings': account.id },
      h(Fluent.Tooltip, { content: c.help, relationship: 'description' },
        h(Fluent.Switch, { checked: enabled, label: c.toggle, disabled: loading || saving || !data?.can_write,
          onChange: toggle, style: { maxWidth: '100%', minWidth: 0 } })),
      loading && h(Fluent.Spinner, { size: 'tiny', label: c.loading }),
      saving && h(Fluent.Text, { role: 'status', size: 200 }, c.saving),
      data && !data.can_write && h(Fluent.Text, { size: 200, style: muted }, c.readonly),
      error && h(Notice, { intent: 'error' }, error),
      saved && h(Fluent.Text, { role: 'status', size: 200 }, saved),
      uncertain && h(Notice, { intent: 'warning' }, c.unknown),
      !uncertain && needsVerification && h(Notice, null, c.accepted),
      (!quota || !summary.reliable || !fresh) && h(Fluent.Text, { size: 200, style: muted }, c.quotaUnavailable),
      h('dl', { style: { ...stack, margin: 0, fontSize: 12 } },
        ...[[c.count, fresh && summary.count !== null ? String(summary.count) : c.refreshNeeded],
          [c.expiry, expiry ? date(expiry) : fresh && summary.count === 0 ? c.none : c.refreshNeeded],
          [c.result, data ? outcome : c.refreshNeeded]].map(([label, value]) => h('div', { key: label, style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
            h('dt', { style: muted }, label), h('dd', { style: { margin: 0 } }, value)))),
      h(Fluent.Button, { size: 'small', appearance: 'subtle', style: { justifySelf: 'start' }, disabled: loading || saving,
        onClick: () => { setSaved(''); setReload(value => value + 1); } }, c.refresh));
  }

  function AccountResetSettings({ api, tenantExternalId, locale, context }) {
    const account = context?.upstreamAccount;
    const tenant = tenantExternalId?.trim() ?? '';
    // Missing or cross-tenant context must never start a request or infer another account.
    if (!tenant || !account || account.tenantExternalId !== tenant || account.provider !== 'openai-codex'
      || typeof account.id !== 'string' || !account.id || typeof account.name !== 'string') return null;
    if (typeof api?.requestApi !== 'function') return h(Notice, { intent: 'warning' }, copyFor(locale).unavailable);
    return h(AccountDetails, { key: `${tenant}:${account.id}`, account, api, tenant, locale, quotaSnapshot: context.quotaSnapshot });
  }
  return defineOperatorUiPackage({
    apiVersion: 'operator-ui-package-v1', pluginId: PLUGIN_ID,
    compatiblePluginVersions: ['1.2.0'], components: { 'account-reset-settings': AccountResetSettings },
  });
}
