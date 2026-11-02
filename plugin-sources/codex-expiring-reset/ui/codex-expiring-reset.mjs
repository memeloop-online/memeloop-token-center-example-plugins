// All presentation primitives come from the authenticated operator host.
// Presentation uses account names, scoped summaries and host-provided status.
export function createPresentation(React, Fluent) {
  const h = React.createElement;
  const styles = {
    page: { display: 'grid', gap: 24, maxWidth: 1080, margin: '0 auto', padding: '24px 16px' },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 },
    stack: { display: 'grid', gap: 12, minWidth: 0 },
    metrics: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 },
    metric: { display: 'grid', gap: 8, padding: 20, minWidth: 0 },
    subdued: { color: Fluent.tokens.colorNeutralForeground2 },
  };

  function Notice({ intent = 'info', children }) {
    return h(Fluent.MessageBar, { intent },
      h(Fluent.MessageBarBody, null, children));
  }

  function Metric({ label, value, note }) {
    return h(Fluent.Card, { appearance: 'outline', style: styles.metric },
      h(Fluent.Text, { size: 200, style: styles.subdued }, label),
      h(Fluent.Text, { size: 500, weight: 'semibold', style: { overflowWrap: 'anywhere' } }, value),
      note && h(Fluent.Text, { size: 200, style: styles.subdued }, note));
  }

  function Intro() {
    return h('header', { style: styles.stack },
      h(Fluent.Badge, { appearance: 'tint', color: 'brand', style: { justifySelf: 'start' } }, 'Codex · 自动化'),
      h(Fluent.Text, { as: 'h1', size: 700, weight: 'semibold', style: { margin: 0 } }, '手动重置次数到期前自动使用'),
      h(Fluent.Text, { style: styles.subdued },
        '为已开启的 Codex 账号，在手动重置次数到期前 10 分钟自动使用一次。'));
  }

  function Empty({ title, description }) {
    return h(Fluent.Card, { appearance: 'outline', style: { padding: 32, textAlign: 'center' } },
      h(Fluent.Text, { as: 'h2', size: 500, weight: 'semibold' }, title),
      h(Fluent.Text, { style: styles.subdued }, description));
  }

  return { h, styles, Notice, Metric, Intro, Empty };
}

const PLUGIN_ID = 'mtc-codex-expiring-reset';
const scopePath = (path, tenant) => `${path}?${new URLSearchParams({ tenant_external_id: tenant })}`;
const errorCopy = (error) => {
  if ([401, 403].includes(error?.status)) return '当前账号缺少操作权限，请联系管理员。';
  if (error?.status === 409) return '授权已被其他操作更新。请刷新后确认当前设置。';
  if (error?.status === 404) return '升级宿主版本后即可使用此功能，请联系管理员。';
  return '暂时无法读取或保存设置。请刷新核实当前状态后重试。';
};

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
  const { h, styles, Notice, Metric, Intro, Empty } = createPresentation(React, Fluent);

  function AccountDetails({ account, api, tenant, locale }) {
    const [data, setData] = React.useState(null);
    const [quota, setQuota] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const [quotaError, setQuotaError] = React.useState(false);
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
      setLoading(true); setData(null); setQuota(null); setError(''); setQuotaError(false);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
      Promise.allSettled([
        api.requestApi({ path: base, signal }).then(value => {
          const checked = validateEnvelope(value, account.id, tenant);
          if (!controller.signal.aborted) setData(checked);
        }).catch(reason => { if (!controller.signal.aborted) setError(errorCopy(reason)); }),
        api.requestApi({ path: scopePath(`/internal/v1/upstreams/${encodeURIComponent(account.id)}/quota`, tenant), signal }).then(value => {
          if (value?.contract_version !== 'upstream_quota_v1' || value.upstream_account_id !== account.id
            || value.tenant_external_id !== tenant) throw new Error('Quota scope mismatch');
          if (!controller.signal.aborted) { setQuota(value); setNow(Date.now()); }
        }).catch(() => { if (!controller.signal.aborted) setQuotaError(true); }),
      ]).finally(() => { if (!controller.signal.aborted) setLoading(false); });
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
    const summary = creditSummary(quota, now);
    const fresh = quota && Number.isFinite(quota.stale_after) && quota.stale_after > now;
    const expiry = fresh && summary.reliable ? summary.expiry : null;
    const date = value => Number.isFinite(value) ? new Date(value).toLocaleString(locale || 'zh-CN') : '暂未获取';
    const outcome = uncertain ? '需要核实'
      : blocked ? '已暂停，等待检查'
        : result === 'accepted' ? '已使用一次'
          : operation?.settled_at ? '已核实' : '等待';
    async function toggle() {
      if (writing.current || !data?.can_write || (needsVerification && !enabled)) return;
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
          setSaved(checked.grant?.enabled ? '已开启此账号的自动使用授权。' : '已关闭此账号的自动使用授权。');
        }
      } catch (reason) {
        if (alive.current && generation.current === expectedGeneration) { setData(null); setError(errorCopy(reason)); }
      } finally {
        writing.current = false;
        if (alive.current && generation.current === expectedGeneration) setSaving(false);
      }
    }
    return h('section', { style: styles.stack, 'aria-label': `${account.name}的自动使用设置`, 'aria-busy': loading || saving },
      h(Fluent.Card, { appearance: 'outline', style: { padding: 24 } },
        h('div', { style: styles.row },
          h('div', { style: styles.stack },
            h(Fluent.Text, { as: 'h2', size: 500, weight: 'semibold' }, account.name),
            h(Fluent.Text, { style: styles.subdued }, '账号授权 · 每个账号单独开启，可随时关闭')),
          h(Fluent.Switch, {
            checked: enabled, label: saving ? '正在保存…' : data ? enabled ? '授权已开启' : '授权已关闭' : '授权待确认',
            disabled: loading || saving || !data?.can_write || (!enabled && needsVerification),
            onChange: toggle,
          })),
        data && !data.can_write && h(Notice, { intent: 'warning' }, '当前为只读模式。'),
        data && !enabled && h(Fluent.Text, { style: styles.subdued }, '开启后，在手动重置次数到期前 10 分钟自动使用一次。')),
      loading && h(Fluent.Spinner, { size: 'small', label: '正在读取授权与手动重置次数…' }),
      error && h(Notice, { intent: 'error' }, error),
      saved && h(Notice, { intent: 'success' }, saved),
      uncertain && h(Notice, { intent: 'warning' }, '上次使用结果待核实，自动使用已暂停。请打开上游账号查看重置记录。'),
      !uncertain && needsVerification && h(Notice, null, '已使用一次，正在等待结果核实。核实完成后才能继续自动使用。'),
      (quotaError || (quota && (!summary.reliable || !fresh))) && h(Notice, { intent: 'warning' }, '手动重置次数信息待确认。系统会重新检查可用次数和到期时间。'),
      h('div', { style: styles.metrics },
        h(Metric, { label: '可用手动重置次数', value: fresh && summary.count !== null ? `${summary.count} 次` : '暂未获取' }),
        h(Metric, { label: '最近一次到期', value: expiry ? date(expiry) : fresh && summary.count === 0 ? '暂无可用次数' : '暂未获取' }),
        h(Metric, { label: '预计开始执行', value: !data ? '待确认授权' : !enabled ? '未开启' : needsVerification ? '等待核实' : blocked ? '等待检查' : expiry ? date(expiry - 600_000) : '等待有效到期时间', note: '在到期前 10 分钟内检查并执行' }),
        h(Metric, { label: '最后结果', value: data ? outcome : '暂未获取', note: grant?.last_attempt_at ? `最近检查 ${date(grant.last_attempt_at)}` : '尚无自动执行检查记录' })),
      h(Fluent.Card, { appearance: 'outline', style: { padding: 24 } },
        h('div', { style: styles.row },
          h(Fluent.Text, { as: 'h2', size: 400, weight: 'semibold' }, '重置记录'),
          h(Fluent.Button, { appearance: 'subtle', onClick: () => api.navigate('upstreams'), disabled: typeof api.navigate !== 'function' }, '打开上游账号')),
        !data ? h(Fluent.Text, null, '读取授权后显示关联的重置记录。')
          : !operation ? h(Fluent.Text, { style: styles.subdued }, '暂无重置记录。')
            : h('div', { style: styles.stack },
              h(Fluent.Badge, { appearance: 'tint', color: uncertain ? 'warning' : result === 'accepted' ? 'success' : 'informative', style: { justifySelf: 'start' } }, outcome),
              h(Fluent.Text, null, operation.settled_at ? `已核实于 ${date(operation.settled_at)}` : '结果核实中。'),
              h(Fluent.Text, { style: styles.subdued }, '可在上游账号中查看重置状态并核实。'))),
      h('div', { style: styles.row },
        h(Fluent.Text, { size: 200, style: styles.subdued }, quota?.observed_at ? `次数读取于 ${date(quota.observed_at)}` : '尚无次数读取时间'),
        h(Fluent.Button, { disabled: loading || saving, onClick: () => { setSaved(''); setReload(value => value + 1); } }, '刷新状态')));
  }

  function Workspace({ api, tenantExternalId, locale }) {
    const tenant = tenantExternalId?.trim() ?? '';
    const [accounts, setAccounts] = React.useState([]);
    const [loadedTenant, setLoadedTenant] = React.useState('');
    const [selected, setSelected] = React.useState('');
    const [search, setSearch] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [reload, setReload] = React.useState(0);
    const supported = typeof api?.requestApi === 'function';
    React.useEffect(() => {
      setAccounts([]); setLoadedTenant(''); setSelected(''); setSearch(''); setError('');
      if (!tenant || !supported) return;
      const controller = new AbortController();
      setLoading(true);
      api.requestApi({ path: scopePath('/internal/v1/upstreams', tenant),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
        .then(value => {
          if (!Array.isArray(value)) throw new Error('Unsupported account list');
          const eligible = value.filter(account => account.driver === 'openai-codex'
            && typeof account.id === 'string' && typeof account.name === 'string'
            && (!account.tenant_external_id || account.tenant_external_id === tenant));
          if (!controller.signal.aborted) { setAccounts(eligible); setLoadedTenant(tenant); }
        })
        .catch(reason => { if (!controller.signal.aborted) setError(errorCopy(reason)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      return () => controller.abort();
    }, [api, tenant, supported, reload]);
    const scopedAccounts = loadedTenant === tenant ? accounts : [];
    const account = scopedAccounts.find(value => value.id === selected);
    const filtered = scopedAccounts.filter(value => value.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return h('main', { style: styles.page },
      h(Intro),
      !tenant ? h(Empty, { title: '先选择租户', description: '自动使用授权属于当前租户，请先选择要管理的租户。' })
        : !supported ? h(Notice, { intent: 'warning' }, '升级宿主版本后即可使用此功能，请联系管理员。')
          : h(React.Fragment, null,
            loading && h(Fluent.Spinner, { label: '正在加载 Codex 账号…' }),
            error && h(Notice, { intent: 'error' }, error, ' ', h(Fluent.Button, { size: 'small', onClick: () => setReload(value => value + 1) }, '重试')),
            !loading && !error && loadedTenant === tenant && scopedAccounts.length === 0 && h(Empty, { title: '暂无 Codex 账号', description: '在上游账号中连接 Codex 后，即可为账号单独开启自动使用授权。' }),
            scopedAccounts.length > 0 && h(Fluent.Field, { label: '选择 Codex 账号', hint: '按账号名称搜索。选择后可查看次数、到期时间与授权状态。' },
              h(Fluent.Combobox, {
                placeholder: '搜索并选择账号', value: search || account?.name || '', selectedOptions: account ? [account.id] : [],
                onChange: event => setSearch(event.target.value),
                onOptionSelect: (_event, value) => { setSelected(value.optionValue ?? ''); setSearch(''); },
                style: { width: '100%', maxWidth: 520 },
              }, filtered.map(value => h(Fluent.Option, { key: value.id, value: value.id, text: value.name }, value.name)),
              filtered.length === 0 && h(Fluent.Option, { disabled: true, value: '__empty' }, '没有匹配的账号'))),
            account ? h(AccountDetails, { key: `${tenant}:${account.id}`, account, api, tenant, locale })
              : scopedAccounts.length > 0 && h(Empty, { title: '选择一个账号查看设置', description: '选择后可查看手动重置次数并开启自动使用。' })));
  }
  return defineOperatorUiPackage({
    apiVersion: 'operator-ui-package-v1',
    pluginId: PLUGIN_ID,
    compatiblePluginVersions: ['1.0.0'],
    components: { workspace: Workspace },
  });
}
