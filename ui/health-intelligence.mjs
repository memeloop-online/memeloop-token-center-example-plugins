const PLUGIN_ID = 'mtc-health-intelligence';
const PLUGIN_VERSIONS = ['1.1.0', '1.2.0', '1.2.1'];
const COMPONENT_ID = 'health-intelligence';
const ENDPOINT_ID = 'health-intelligence';
const TICK_INTERVAL_MS = 30 * 1000;
const STALE_FETCH_AGE_MS = 20 * 60 * 1000;
export const MAX_SOURCES = 64;
export const MAX_ROWS = 24;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function safeSourceHref(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '' ? url.href : null;
  } catch { return null; }
}

export function snapshotSources(value) {
  if (!value || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw new Error('Health data needs a valid source list');
  }
  return value.sources;
}

export function runtimeSnapshot(response, now = Date.now()) {
  const provenance = response && response.provenance;
  if (!provenance || provenance.plugin_id !== PLUGIN_ID || provenance.endpoint_id !== ENDPOINT_ID) {
    throw new Error('Health data could not be verified');
  }
  let freshness = provenance.freshness;
  if (freshness === undefined) {
    const fetched = provenance.fetched_at;
    freshness = provenance.source === 'fallback' ? 'unavailable'
      : response.partial || provenance.source === 'stale_cache'
        || !Number.isFinite(fetched) || fetched > now + MAX_CLOCK_SKEW_MS
        || now - fetched > STALE_FETCH_AGE_MS ? 'stale' : 'fresh';
  }
  if (!['fresh', 'stale', 'unavailable'].includes(freshness)) {
    throw new Error('Health data could not be verified');
  }
  const data = response.data;
  const sources = snapshotSources(data);
  if (!response.partial && freshness === 'fresh') return data;
  return { ...data, ...(freshness === 'unavailable' ? { generatedAt: null } : {}), sources: sources.map((source) => ({ ...source,
    ...(freshness === 'unavailable' ? { fetchedAt: null, sourceUpdatedAt: null } : {}),
    status: source.status === 'error' || freshness === 'unavailable' ? 'error' : 'stale',
  })) };
}

const STRINGS = {
  title: { en: 'Model health & intelligence', zh: '模型健康与能力' },
  refresh: { en: 'Refresh', zh: '刷新' },
  refreshing: { en: 'Refreshing…', zh: '刷新中…' },
  loading: { en: 'Loading health data…', zh: '正在加载健康数据…' },
  loadFailed: { en: 'Health data failed to load', zh: '健康数据加载失败' },
  tryAgain: { en: 'Try again', zh: '重试' },
  openPage: { en: 'Open source page', zh: '打开来源页面' },
  fetchedAt: { en: 'Fetched', zh: '采集时间' },
  sourceUpdatedAt: { en: 'Source updated', zh: '来源更新' },
  emptyRows: { en: 'No source records available', zh: '暂无来源记录' },
  emptySources: { en: 'Awaiting source data', zh: '等待来源数据' },
  updated: { en: 'Updated', zh: '更新于' },
  unavailable: { en: 'Source data is currently unavailable. Collection retries automatically.', zh: '暂时无法获取来源数据，系统会自动重试采集。' },
  refreshHelp: { en: 'Refresh reloads the latest collected data.', zh: '刷新会重新读取最近一次采集结果。' },
  retryHelp: { en: 'Please retry. If the issue persists, check the plugin service status.', zh: '请重试；若问题持续，请检查插件服务状态。' },
  ok: { en: 'Updated', zh: '已更新' },
  stale: { en: 'Stale', zh: '数据偏旧' },
  error: { en: 'Error', zh: '异常' },
  yes: { en: 'Yes', zh: '是' },
  no: { en: 'No', zh: '否' },
};

const COLUMN_LABELS = {
  key: { en: 'Key', zh: '标识' },
  model: { en: 'Model', zh: '模型' },
  name: { en: 'Name', zh: '名称' },
  effort: { en: 'Effort', zh: '推理档位' },
  iq: { en: 'IQ', zh: '综合 IQ' },
  softwareIq: { en: 'Software IQ', zh: '软件 IQ' },
  visualIq: { en: 'Visual IQ', zh: '视觉 IQ' },
  samples: { en: 'Samples', zh: '样本数' },
  passRate: { en: 'Pass rate', zh: '通过率' },
  passAt4: { en: 'Pass@4', zh: 'Pass@4' },
  averageCostUsd: { en: 'Avg cost', zh: '平均成本' },
  outputTokens: { en: 'Output tokens', zh: '输出词元' },
  agentSteps: { en: 'Agent steps', zh: '代理步骤' },
  providerType: { en: 'Provider type', zh: '提供方类型' },
  status: { en: 'Status', zh: '状态' },
  latencyMs: { en: 'Latency (ms)', zh: '延迟 (ms)' },
  pingLatencyMs: { en: 'Ping (ms)', zh: 'Ping (ms)' },
  checkedAt: { en: 'Checked at', zh: '检查时间' },
  message: { en: 'Message', zh: '消息' },
};

const DATE_COLUMNS = new Set(['checkedAt']);
const PERCENT_COLUMNS = new Set(['passRate', 'passAt4']);
const CURRENCY_COLUMNS = new Set(['averageCostUsd']);

function columnsOf(rows) {
  const columns = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (key !== 'key' && !columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

export function isRuntimeStale(source, now) {
  const fetched = Date.parse(source && source.fetchedAt);
  if (!Number.isFinite(fetched) || fetched > now + MAX_CLOCK_SKEW_MS
      || now - fetched > STALE_FETCH_AGE_MS) return true;
  const updated = source && source.sourceUpdatedAt == null ? fetched : Date.parse(source.sourceUpdatedAt);
  if (!Number.isFinite(updated) || updated > now + MAX_CLOCK_SKEW_MS) return true;
  const maxAge = Number(source && source.maxObservationAgeSeconds);
  if (Number.isFinite(updated) && Number.isFinite(maxAge) && maxAge >= 0
      && now - updated > maxAge * 1000) return true;
  return false;
}

function effectiveStatus(source, now) {
  if (source && source.status === 'error') return 'error';
  if ((source && source.status === 'stale') || isRuntimeStale(source, now)) return 'stale';
  return 'ok';
}

export function activateOperatorUi(host) {
  const React = host.React;
  const Fluent = host.Fluent;
  const { createElement: h, useEffect, useMemo, useState } = React;
  const {
    Badge,
    Button,
    Caption1,
    Link,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
    Text,
    makeStyles,
    mergeClasses,
    tokens,
  } = Fluent;

  const useStyles = makeStyles({
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: tokens.spacingVerticalL,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: tokens.spacingHorizontalM,
      flexWrap: 'wrap',
    },
    headerMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: tokens.spacingHorizontalM,
      flexWrap: 'wrap',
    },
    grid: {
      display: 'grid',
      gap: tokens.spacingHorizontalL,
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 520px), 1fr))',
    },
    gridCompact: {
      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
      gap: tokens.spacingHorizontalM,
    },
    card: {
      display: 'flex',
      flexDirection: 'column',
      gap: tokens.spacingVerticalM,
      padding: tokens.spacingHorizontalL,
      minWidth: 0,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: tokens.borderRadiusLarge,
      backgroundColor: tokens.colorNeutralBackground1,
    },
    cardHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: tokens.spacingHorizontalS,
      flexWrap: 'wrap',
    },
    meta: {
      display: 'flex',
      flexDirection: 'column',
      gap: tokens.spacingVerticalXXS,
      color: tokens.colorNeutralForeground3,
    },
    tableWrap: {
      overflowX: 'auto',
    },
    center: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: tokens.spacingVerticalM,
      padding: tokens.spacingVerticalXXXL,
      textAlign: 'center',
    },
  });

  const BADGE_COLORS = { ok: 'success', stale: 'warning', error: 'danger' };

  function HealthIntelligence(props) {
    const styles = useStyles();
    const locale = String(props.locale || '').toLowerCase();
    const lang = locale.startsWith('zh') ? 'zh' : 'en';
    const dateLocale = lang === 'zh' ? 'zh-CN' : 'en-US';
    const text = (pair) => pair[lang];

    const [snapshot, setSnapshot] = useState(null);
    const [failure, setFailure] = useState(null);
    const [initialLoading, setInitialLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
      return () => clearInterval(timer);
    }, []);

    useEffect(() => {
      const controller = new AbortController();
      let active = true;
      setRefreshing(true);
      props.api.loadServiceData(ENDPOINT_ID, controller.signal).then((response) => {
        if (!active) return;
        const data = runtimeSnapshot(response);
        setSnapshot(data);
        setFailure(null);
        setInitialLoading(false);
        setRefreshing(false);
      }).catch((reason) => {
        if (!active || (reason && reason.name === 'AbortError')) return;
        setFailure(reason);
        setInitialLoading(false);
        setRefreshing(false);
      });
      return () => {
        active = false;
        controller.abort();
      };
    }, [props.api, reloadKey]);

    const formats = useMemo(() => ({
      date: new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'medium' }),
      number: new Intl.NumberFormat(dateLocale),
      percent: new Intl.NumberFormat(dateLocale, { style: 'percent', maximumFractionDigits: 1 }),
      currency: new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
    }), [dateLocale]);

    const formatDate = (value) => {
      const time = Date.parse(value);
      return Number.isFinite(time) && time > 0 ? formats.date.format(new Date(time)) : '—';
    };

    const formatCell = (column, value) => {
      if (value === null || value === undefined || value === '') return '—';
      if (DATE_COLUMNS.has(column)) return formatDate(value);
      if (typeof value === 'number') {
        if (PERCENT_COLUMNS.has(column)) return formats.percent.format(value);
        if (CURRENCY_COLUMNS.has(column)) return formats.currency.format(value);
        return formats.number.format(value);
      }
      if (typeof value === 'boolean') return text(value ? STRINGS.yes : STRINGS.no);
      return String(value);
    };

    const columnLabel = (column) => {
      const entry = COLUMN_LABELS[column];
      return entry ? text(entry) : column;
    };

    const reload = () => setReloadKey((value) => value + 1);

    const title = text(STRINGS.title);
    const refreshButton = h(Button, {
      appearance: 'primary',
      size: props.compact ? 'small' : 'medium',
      disabled: refreshing,
      onClick: reload,
    }, refreshing ? text(STRINGS.refreshing) : text(STRINGS.refresh));

    if (initialLoading) {
      return h('div', { className: styles.root },
        h('div', { className: styles.header },
          h(Text, { as: 'h2', size: 600, weight: 'semibold' }, title)),
        h('div', { className: styles.center, role: 'status' },
          h(Spinner, { size: 'large', label: text(STRINGS.loading), labelPosition: 'below' })));
    }

    if (failure) {
      return h('div', { className: styles.root },
        h('div', { className: styles.header },
          h(Text, { as: 'h2', size: 600, weight: 'semibold' }, title),
          refreshButton),
        h('div', { className: styles.center, role: 'alert' },
          h(Text, { size: 400, weight: 'semibold' }, text(STRINGS.loadFailed)),
          h(Caption1, null, text(STRINGS.retryHelp)),
          h(Button, { appearance: 'secondary', onClick: reload }, text(STRINGS.tryAgain))));
    }

    const sources = snapshot ? snapshotSources(snapshot) : [];

    const renderTable = (source) => {
      const rows = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : [];
      if (rows.length === 0) {
        return h(Caption1, null, text(STRINGS.emptyRows));
      }
      const columns = columnsOf(rows);
      return h('div', { className: styles.tableWrap },
        h(Table, { size: props.compact ? 'extra-small' : 'small', 'aria-label': source.label },
          h(TableHeader, null,
            h(TableRow, null,
              columns.map((column) => h(TableHeaderCell, { key: column }, columnLabel(column))))),
          h(TableBody, null,
            rows.map((row, index) => h(TableRow, { key: (row && row.key) || index },
              columns.map((column) => h(TableCell, { key: column }, formatCell(column, row ? row[column] : null))))))));
    };

    const renderSource = (source) => {
      const status = effectiveStatus(source, now);
      const sourceHref = safeSourceHref(source.pageUrl);
      const metaItems = [
        `${text(STRINGS.fetchedAt)}: ${formatDate(source.fetchedAt)}`,
        `${text(STRINGS.sourceUpdatedAt)}: ${formatDate(source.sourceUpdatedAt)}`,
      ];
      if (source.error) metaItems.push(text(STRINGS.unavailable));
      return h('section', { key: source.id || source.label, className: styles.card },
        h('div', { className: styles.cardHeader },
          h(Text, { as: 'h3', size: 500, weight: 'semibold' }, source.label),
          h(Badge, { appearance: 'filled', color: BADGE_COLORS[status] }, text(STRINGS[status]))),
        h('div', { className: styles.meta },
          metaItems.map((item) => h(Caption1, { key: item }, item)),
          sourceHref
            ? h(Link, { href: sourceHref, target: '_blank', rel: 'noopener noreferrer' }, text(STRINGS.openPage))
            : null),
        renderTable(source));
    };

    return h('div', { className: styles.root },
      h('div', { className: styles.header },
        h(Text, { as: 'h2', size: 600, weight: 'semibold' }, title),
        h('div', { className: styles.headerMeta },
          snapshot && snapshot.generatedAt
            ? h(Caption1, null, `${text(STRINGS.updated)}: ${formatDate(snapshot.generatedAt)}`)
            : null,
          refreshing ? h(Spinner, { size: 'tiny' }) : null,
          refreshButton)),
      h(Caption1, null, text(STRINGS.refreshHelp)),
      sources.length === 0
        ? h('div', { className: styles.center, role: 'status' },
            h(Caption1, null, text(STRINGS.emptySources)))
        : h('div', { className: mergeClasses(styles.grid, props.compact && styles.gridCompact) },
            sources.map(renderSource)));
  }

  return host.defineOperatorUiPackage({
    apiVersion: 'operator-ui-package-v1',
    pluginId: PLUGIN_ID,
    compatiblePluginVersions: PLUGIN_VERSIONS,
    components: { [COMPONENT_ID]: HealthIntelligence },
  });
}
