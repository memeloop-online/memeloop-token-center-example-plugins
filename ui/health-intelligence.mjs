const PLUGIN_ID = 'mtc-health-intelligence';
const PLUGIN_VERSIONS = ['1.1.0', '1.2.0', '1.2.1', '1.3.0'];
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
      : (response.partial && !response.data?.sources?.some(source => source.status === 'error')) || provenance.source === 'stale_cache'
        || !Number.isFinite(fetched) || fetched > now + MAX_CLOCK_SKEW_MS
        || now - fetched > STALE_FETCH_AGE_MS ? 'stale' : 'fresh';
  }
  if (!['fresh', 'stale', 'unavailable'].includes(freshness)) {
    throw new Error('Health data could not be verified');
  }
  const data = response.data;
  const sources = snapshotSources(data);
  if (freshness === 'fresh') return data;
  return { ...data, collectionStale: true, ...(freshness === 'unavailable' ? { generatedAt: null } : {}), sources: sources.map((source) => ({ ...source,
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
  fetchedAt: { en: 'Fetched', zh: '最近采集' },
  sourceUpdatedAt: { en: 'Source observation', zh: '来源采样时间' },
  emptyRows: { en: 'No source records available', zh: '暂无来源记录' },
  emptySources: { en: 'Awaiting source data', zh: '等待来源数据' },
  updated: { en: 'Updated', zh: '更新于' },
  unavailable: { en: 'Source data is currently unavailable. Collection retries automatically.', zh: '暂时无法获取来源数据，系统会自动重试采集。' },
  refreshHelp: { en: 'Refresh reloads collected results; each source publishes on its own schedule. Public benchmarks and third-party probes provide reference data.', zh: '刷新读取最近采集结果；来源按各自周期发布。公开评测与第三方探测用于辅助比较。' },
  retryHelp: { en: 'Please retry. If the issue persists, check the plugin service status.', zh: '请重试；若问题持续，请检查插件服务状态。' },
  ok: { en: 'Collected', zh: '采集正常' },
  stale: { en: 'Cached result', zh: '缓存待刷新' },
  error: { en: 'Error', zh: '异常' },
  operational: { en: 'Operational', zh: '正常' },
  degraded: { en: 'Degraded', zh: '降级' },
  unknown: { en: 'Unknown', zh: '未知' },
  sourceOld: { en: 'Older source observations', zh: '来源采样较早' },
  sourceUnknown: { en: 'Source time not provided', zh: '来源未提供采样时间' },
  sourceOldHelp: { en: 'Collection succeeded. The source still publishes these older observations.', zh: '已取得来源数据；来源当前发布的采样时间较早。' },
  cachedHelp: { en: 'Showing a cached result. Collection has not produced a newer snapshot yet.', zh: '正在显示缓存结果，尚未取得新的采集快照。' },
  missingHelp: { en: 'Source observation time awaits publication. Collection time is shown separately.', zh: '采样时间待来源提供，采集时间单独展示。' },
  details: { en: 'All collected records', zh: '查看全部采集记录' },
  noChart: { en: 'Chart unavailable; all values are listed below.', zh: '当前无法显示图表，可查看下方完整数值。' },
  noMetric: { en: 'No valid values for this metric', zh: '此指标暂无有效数值' },
  history: { en: 'Recent response-start observations', zh: '近期开始响应耗时' },
  historyHelp: { en: 'Up to six actual checks per provider. Missing values appear as gaps.', zh: '每个提供方最多展示最近 6 次实际检查；缺失值以断点显示。' },
  scopeHealth: { en: 'Third-party provider checks. Latency measures the wait until the upstream begins responding.', zh: '第三方提供方探测；耗时为上游开始响应前的等待时间。' },
  scopeRadar: { en: 'Codex Radar benchmark IQ scores. Compare only within this source and reasoning setting.', zh: 'Codex Radar 的 IQ 评测分数，仅在同一来源与推理档位下比较。' },
  scopeSwe: { en: 'DeepSWE engineering benchmark; pass rate and Pass@4 have different meanings. Cost is the source estimate in USD.', zh: 'DeepSWE 工程评测；单次通过率与 Pass@4 含义不同。成本为来源估算，单位美元。' },
  records: { en: 'Collected records (up to 24)', zh: '已采集记录（最多 24 条）' },
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
  averageCostUsd: { en: 'Avg cost (USD)', zh: '平均成本 (USD)' },
  outputTokens: { en: 'Output tokens', zh: '输出词元' },
  agentSteps: { en: 'Agent steps', zh: '代理步骤' },
  harness: { en: 'Harness', zh: '评测脚手架' },
  provider: { en: 'Provider', zh: '提供方' },
  config: { en: 'Configuration', zh: '评测配置' },
  costBasis: { en: 'Source cost basis', zh: '来源计价依据' },
  providerType: { en: 'Provider type', zh: '提供方类型' },
  status: { en: 'Status', zh: '状态' },
  latencyMs: { en: 'Response start (ms)', zh: '开始响应耗时 (ms)' },
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
      if (key !== 'key' && !/^sample[0-5](At|Status|LatencyMs)$/.test(key) && !columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

export function freshnessReason(source, now = Date.now()) {
  if (!source || source.status === 'error') return 'error';
  if (source.collectionStale) return 'stale';
  const fetched = Date.parse(source.fetchedAt);
  if (!Number.isFinite(fetched) || fetched > now + MAX_CLOCK_SKEW_MS
      || now - fetched > STALE_FETCH_AGE_MS) return 'stale';
  const observed = source.sourceUpdatedAt == null ? null : Date.parse(source.sourceUpdatedAt);
  if (observed !== null && (!Number.isFinite(observed) || observed > now + MAX_CLOCK_SKEW_MS)) return 'sourceUnknown';
  const maxAge = Number(source.maxObservationAgeSeconds);
  if (observed !== null && Number.isFinite(maxAge) && maxAge > 0 && now - observed > maxAge * 1000) return 'sourceOld';
  if (source.status === 'stale') return 'stale';
  return observed === null ? 'sourceUnknown' : 'ok';
}

export function isRuntimeStale(source, now) {
  return ['stale', 'sourceOld'].includes(freshnessReason(source, now))
    || (source?.sourceUpdatedAt != null && !Number.isFinite(Date.parse(source.sourceUpdatedAt)))
    || Date.parse(source?.sourceUpdatedAt) > now + MAX_CLOCK_SKEW_MS;
}

// Canvas tooltips avoid interpreting upstream labels as HTML.
export function comparisonOption(source, field, title, percent = false) {
  const rows = (source.rows || []).filter(row => typeof row?.[field] === 'number' && Number.isFinite(row[field])).slice(0, 12);
  const label = row => [row.name || row.model || row.key, row.effort, row.harness].filter(Boolean).join(' · ');
  return {
    animation: false, aria: { enabled: true },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    grid: { left: 8, right: 38, top: 28, bottom: 12, containLabel: true },
    xAxis: { type: 'value', name: title, nameLocation: 'middle', nameGap: 18,
      position: 'top', ...(percent ? { max: 100 } : {}), axisLabel: { formatter: percent ? '{value}%' : '{value}' } },
    yAxis: { type: 'category', inverse: true, data: rows.map(label),
      axisLabel: { width: 105, overflow: 'truncate', fontSize: 11 } },
    series: [{ type: 'bar', name: title, barMaxWidth: 18,
      data: rows.map(row => field === 'latencyMs' ? { value: row[field],
        itemStyle: { color: ({ operational: '#27845e', degraded: '#b77a19', error: '#c34e4e', unknown: '#7b8593' })[row.status] || '#7b8593' } }
        : percent ? Math.round(row[field] * 1000) / 10 : row[field]),
      label: { show: true, position: 'right', fontSize: 10, formatter: percent ? '{c}%' : '{c}' } }],
  };
}

export function historyOption(row, title) {
  const data = [];
  for (let index = 5; index >= 0; index--) {
    const at = Date.parse(row?.[`sample${index}At`]);
    if (!Number.isFinite(at)) continue;
    const value = row[`sample${index}LatencyMs`];
    data.push([at, typeof value === 'number' && Number.isFinite(value) ? value : null]);
  }
  return { animation: false, aria: { enabled: true },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    grid: { left: 8, right: 18, top: 32, bottom: 12, containLabel: true },
    xAxis: { type: 'time', axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', name: 'ms', min: 0 },
    series: [{ type: 'line', name: title, data, connectNulls: false, showSymbol: true }],
  };
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
    Select,
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
      gridTemplateColumns: 'minmax(0, 1fr)',
      gap: tokens.spacingHorizontalM,
    },
    card: {
      display: 'flex',
      flexDirection: 'column',
      gap: tokens.spacingVerticalM,
      padding: tokens.spacingHorizontalL,
      minWidth: 0,
      overflowWrap: 'anywhere',
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
    records: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: tokens.spacingHorizontalM },
    record: { minWidth: 0, overflowWrap: 'anywhere', padding: tokens.spacingHorizontalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
    values: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalS, margin: 0 },
    value: { margin: 0, overflowWrap: 'anywhere' },
    chart: { width: '100%', minWidth: 0 },
    select: { maxWidth: '100%', minWidth: 0, padding: '8px', color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorNeutralBackground1 },

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

  const BADGE_COLORS = { ok: 'success', stale: 'warning', sourceOld: 'informative', sourceUnknown: 'subtle', error: 'danger' };

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
    const [metrics, setMetrics] = useState({});
    const [healthKey, setHealthKey] = useState('');
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
        const captured = response.provenance?.fetched_at;
        setSnapshot({ ...data, collectionFetchedAt: typeof captured === 'number' && Number.isFinite(captured)
          && captured > 0 && captured <= Date.now() + MAX_CLOCK_SKEW_MS ? new Date(captured).toISOString() : null });
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
      if (column === 'status') {
        const status = ['operational', 'degraded', 'error', 'unknown'].includes(value) ? value : 'unknown';
        return text(STRINGS[status]);
      }
      if (value === null || value === undefined || value === '') return '—';
      if (column === 'effort' && value === 'unspecified') return lang === 'zh' ? '未注明' : 'Unspecified';
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

    const renderRecords = (source) => {
      const rows = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : [];
      if (!rows.length) return h(Caption1, null, text(STRINGS.emptyRows));
      return h('details', null,
        h('summary', { style: { cursor: 'pointer', padding: '8px 0' } }, text(STRINGS.details), ` (${rows.length})`),
        h('div', { className: styles.records }, rows.map((row, index) => h('article', {
          key: `${row?.key || 'record'}:${index}`, className: styles.record,
        }, h('dl', { className: styles.values }, columnsOf([row]).map(column => h(React.Fragment, { key: column },
          h('dt', null, columnLabel(column)),
          h('dd', { className: styles.value }, formatCell(column, row[column])))))))));
    };

    const chart = (option, label, height) => host.EChart
      ? h(host.EChart, { option, ariaLabel: label, locale: lang === 'zh' ? 'zh-CN' : 'en',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, style: { width: '100%', height, minWidth: 0 } })
      : h(Caption1, null, text(STRINGS.noChart));

    const renderCharts = (source) => {
      const rows = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : [];
      if (!rows.length) return null;
      const choices = source.id === 'aixhan' ? ['latencyMs', 'pingLatencyMs', 'status']
        : source.id === 'deepswe' ? ['passRate', 'passAt4', 'averageCostUsd']
        : source.id === 'codexradar' ? ['iq', 'softwareIq', 'visualIq'] : [];
      if (!choices.length) return null;
      const field = choices.includes(metrics[source.id]) ? metrics[source.id] : choices[0];
      const label = columnLabel(field);
      const count = rows.filter(row => typeof row[field] === 'number').slice(0, 12).length;
      const selected = rows.find(row => row.key === healthKey) || rows[0];
      const hasHistory = source.id === 'aixhan' && rows.some(row => row.sample0At);
      return h('div', { className: styles.chart },
        h('label', null, lang === 'zh' ? '图表指标 ' : 'Chart metric ',
          h(Select || 'select', { className: styles.select, value: field,
            onChange: event => setMetrics(value => ({ ...value, [source.id]: event.target.value })),
            'aria-label': `${source.label} ${lang === 'zh' ? '图表指标' : 'chart metric'}` },
            choices.map(value => h('option', { key: value, value }, columnLabel(value))))),
        h(Caption1, null, lang === 'zh' ? `图中最多展示 12 条，完整数值见下方记录。` : 'Chart shows up to 12 records. All collected values are listed below.'),
        source.id === 'aixhan' ? h('div', { className: styles.cardHeader }, ['operational', 'degraded', 'error', 'unknown'].map(status =>
          h(Badge, { key: status, appearance: 'tint', color: ({ operational: 'success', degraded: 'warning', error: 'danger', unknown: 'subtle' })[status] },
            `${text(STRINGS[status])} ${rows.filter(row => (['operational','degraded','error'].includes(row.status) ? row.status : 'unknown') === status).length}`))) : null,
        field === 'status' ? chart({ animation: false, aria: { enabled: true },
          tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
          grid: { left: 8, right: 20, top: 20, bottom: 16, containLabel: true },
          xAxis: { type: 'category', data: ['operational', 'degraded', 'error', 'unknown'].map(value => text(STRINGS[value])) },
          yAxis: { type: 'value', minInterval: 1, name: lang === 'zh' ? '提供方数' : 'Providers' },
          series: [{ type: 'bar', data: ['operational', 'degraded', 'error', 'unknown'].map(value => rows.filter(row =>
            (['operational','degraded','error'].includes(row.status) ? row.status : 'unknown') === value).length) }],
        }, label, 220) : count ? chart(comparisonOption(source, field, label, ['passRate', 'passAt4'].includes(field)), label, Math.max(180, count * 38 + 58))
          : h(Caption1, null, text(STRINGS.noMetric)),
        hasHistory ? h('div', null,
          h('label', null, text(STRINGS.history), ' ',
            h(Select || 'select', { className: styles.select, value: selected.key, onChange: event => setHealthKey(event.target.value),
              'aria-label': lang === 'zh' ? '选择探测提供方' : 'Select checked provider' },
              rows.map(row => h('option', { key: row.key, value: row.key }, row.name || row.key)))),
          chart(historyOption(selected, text(STRINGS.history)), text(STRINGS.history), 220),
          h(Caption1, null, text(STRINGS.historyHelp)),
          h('details', null, h('summary', null, lang === 'zh' ? '查看近期检查数值' : 'Recent check values'),
            h('ul', { style: { paddingInlineStart: 20, overflowWrap: 'anywhere' } }, Array.from({ length: 6 }, (_, index) =>
              selected[`sample${index}At`] ? h('li', { key: index },
                `${formatDate(selected[`sample${index}At`])} · ${formatCell('status', selected[`sample${index}Status`])} · ${formatCell('latencyMs', selected[`sample${index}LatencyMs`])} ms`) : null)))) : null);
    };

    const renderSource = (source) => {
      const status = freshnessReason({ ...source, collectionStale: snapshot.collectionStale, fetchedAt: snapshot.collectionFetchedAt || source.fetchedAt }, now);
      const sourceHref = safeSourceHref(source.pageUrl);
      const metaItems = [
        `${text(STRINGS.fetchedAt)}: ${formatDate(snapshot.collectionFetchedAt)}`,
        `${source.id === 'aixhan' ? (lang === 'zh' ? '最近探测' : 'Latest check') : (lang === 'zh' ? '来源数据发布' : 'Source data published')}: ${formatDate(source.sourceUpdatedAt)}`,
        `${lang === 'zh' ? '来源响应 / 采集时间' : 'Source response / collection time'}: ${formatDate(source.fetchedAt)}`,
      ];
      if (source.error || status === 'error') metaItems.push(text(STRINGS.unavailable));
      if (status === 'sourceOld') metaItems.push(text(STRINGS.sourceOldHelp));
      if (status === 'sourceUnknown') metaItems.push(text(STRINGS.missingHelp));
      if (status === 'stale') metaItems.push(text(STRINGS.cachedHelp));
      return h('section', { key: source.id || source.label, className: styles.card },
        h('div', { className: styles.cardHeader },
          h(Text, { as: 'h3', size: 500, weight: 'semibold' }, source.label),
          h(Badge, { appearance: 'filled', color: BADGE_COLORS[status] }, text(STRINGS[status]))),
        h('div', { className: styles.meta },
          metaItems.map((item) => h(Caption1, { key: item }, item)),
          sourceHref
            ? h(Link, { href: sourceHref, target: '_blank', rel: 'noopener noreferrer' }, text(STRINGS.openPage))
            : null),
        h(Caption1, null, text(STRINGS[source.id === 'aixhan' ? 'scopeHealth' : source.id === 'deepswe' ? 'scopeSwe' : 'scopeRadar'])),
        renderCharts(source),
        renderRecords(source));
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
