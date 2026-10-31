# Health Intelligence 后台并发建议

此实现复用仓库现有 Node Health Intelligence 服务，为固定租户后台读取真实 MTC 观测，输出人工审阅的描述性建议。默认关闭，插件不会更改准入、路由、账号配置或并发限制。

当前签名 Wasm 组件仍只采集三个公开模型健康来源。其 host HTTP 能力不包含私有核心观测，因此这次 Node companion 不能被描述成已经安装在 Wasm worker 上的功能。UI 接入需要核心提供带双 scope 与租户校验的私有插件 data adapter；禁止把租户数据发布到公开 Pages 或公开 health snapshot，禁止把服务 token 交给浏览器或填进签名 manifest。

## 启用与鉴权

通过已有 `serve` 入口运行 Node companion；部署配置使用以下环境变量，服务端 secret 通过现有 secret 注入机制提供，不写入仓库、命令历史或插件 manifest。

| 环境变量 | 含义 |
| --- | --- |
| `MTC_CONCURRENCY_ADVICE_ENABLED=true` | 显式启用；默认不采样、不开放建议路由 |
| `MTC_CORE_ORIGIN` | 固定 HTTPS control origin；仅 localhost/loopback 允许 HTTP；不接受 path、URL 用户密码或重定向 |
| `MTC_TENANT_EXTERNAL_ID` | 固定租户，必须配置；客户端不能选择另一租户 |
| `MTC_SERVICE_TOKEN` | 服务端核心凭据，须有 providers:read 与 requests:read；优先使用该租户专属服务凭据 |
| `MTC_ADVICE_READ_TOKEN` | 与核心服务凭据不同的只读 companion 凭据，仅用于受信任服务端代理调用 |
| `MTC_CONCURRENCY_EVIDENCE_POLICY` | 可选 JSON，覆盖下面的证据要求；未知键或无效值启动失败 |

`GET /api/health-intelligence/concurrency-advice` 要求 `Authorization: Bearer <MTC_ADVICE_READ_TOKEN>`；返回 `Cache-Control: no-store`，拒绝 query、POST 和刷新指令。缺数据仍返回 200，并以 `collection/stale/status/blockers` 明确数据状况。它不是公开 health feed；不要将 read token 分发到 UI。现有公开三源 GET 行为不变。

后台每 5 秒发起一次不重叠采样，单次请求 4 秒超时、8 MiB body cap。依次读取：

1. `GET /internal/v1/upstream-concurrency?tenant_external_id=...`，校验 `upstream_concurrency_v1`、租户、时序、上下限及重复序列。
2. `GET /internal/v1/requests?tenant_external_id=...&paged=true&limit=500&from_created_at=...&to_created_at=...`，读取真实请求结果。按返回的 `next_cursor` 翻页，最多 8 页/4000 行；未完整翻页明确 `requests_truncated=true`，停止给建议。窗口仅覆盖实际核心历史（最多 15 分钟），不查询全量请求历史。

资源上界限制的是采集量，不是客户并发。读取建议只读缓存，不触发采样。多个 control 副本、不同账号/代理和不同 measurement_basis 不相加。后台采集失败不会泄露原始异常、凭据、request IDs、样本 attribution IDs 或代理 endpoint。只有观测不新鲜时 current 变为 null；结果数据采集失败会保留新鲜 current 并关闭建议。

## 数据输出

顶层 `contract_version=health_concurrency_advice_v1`，`application_mode=manual_only`。`series[]` 每条保留核心 `dimension/identity/measurement_basis/current/sampled_peak/points`，并附：

| 字段 | 含义 |
| --- | --- |
| `trend` | 有效采样前半/后半中位数差及时间范围；rising/falling/flat/insufficient；不外推未来 |
| `coverage` | 读取到的 terminal 请求数量、实际可匹配数量及每种排除原因；请求总数不等于成功请求数 |
| `buckets[].concurrency` | 配置分桶范围和真实观测 min/max；建议只返回真实观测范围 |
| `cohort` | account/model/upstreamModel/protocol/route/usageBasis，以及输入/输出 tokens 的 2 倍区间；不同 cohort 不比较 latency/TPS |
| `samples/successes/failures/successRate.samples` | 同账号、请求模型、协议、并发桶的全部已知 terminal outcome 分母，包含 usage 缺失和失败。成功率分母有意跨 token/route/upstreamModel 子组，避免只比较成功后才知道的输出字段而虚高成功率 |
| `metricCohortSamples` | 当前严格 latency/TPS cohort 的请求量；与成功率分母独立，不能将每个 cohort 的分母再求和 |
| `observedFrom/observedTo/observationMs` | 此 metric cohort 的实测时间范围 |
| `latencyMs` | 成功请求 duration_ms 中位数，包含其真实端到端语义，不伪装 wire latency |
| `generationTps` | 仅 provider_reported 且 output_tokens 和正 generation_duration_ms 齐全的成功请求，逐请求 output_tokens / generation seconds 的中位数；不是总 TPS，也不是 output_tokens / 请求墙钟时间 |
| 每个指标的 `value/lower/upper/samples` | 估计、区间与独立指标样本数；无界/缺失端点为 null，不能渲染成 0 误差 |
| `evidence` | 精度/观察窗要求、阻塞原因、目标样本量、剩余样本、样本与窗口进度；TPS/latency 不足仍独立给出 blocker |
| `recommendation` | 不足时 null；充分时 observed_range_for_manual_review + 当前 cohort + 对照实测区间；不是可自动下发的 limit |

请求生命周期只接受 succeeded/failed/cancelled，并从 operational_terminal.completed_at 或 completed_at 取结束时间；不会以 lease 消失推断成功。每个请求须在生命周期内至少有两个不截断采样，首尾距生命周期边界不超过一个采样间隔，中间缺口不超过两个间隔；按生命周期内最大采样 owner 数入桶。短于采样间隔、过长而越过历史窗、缺账号或不完整 lifetime 的请求不能伪装成完整实验样本。

## 精度、比较与建议

证据策略默认 confidenceLevel=0.95、maxSuccessRateError=0.05、minObservationMs=60000、maxLatencyRelativeError=0.25、maxTpsRelativeError=0.25、successNonInferiorityMargin=0.05、concurrencyBucketWidth=4。这些是可配置统计要求和展示分桶宽度，**不是固定建议并发阈值**。

成功率用 Hoeffding 区间；latency/TPS 用 DKW 分布带反演中位数区间；按本次输出所有分桶的三个指标做 union bound。目标样本数由 confidence、总区间数和 success error 计算，因此增加 cohort 会提高证据要求，不会把 10 次请求包装成充分观测。

区间依赖 cohort 内 iid 假设。共享上游、时间相关、重试、streaming、transport revision、提示词混合均可能破坏假设；多次刷新和自适应观看不是 sequentially valid 的置信序列。`uncertainty.assumptions` 和 `limitations` 必须展示，不能将 95% 误读成对生产配置成功概率的承诺。失败率和速度的分母不同，输出 token 长度又是事后分组；这些只支持描述性人工审阅，不证明增加并发的因果效果。

仅当两桶处于相同 metric cohort、观察时间段有至少 minObservationMs 的重叠、各指标区间足够精确，且候选成功率下界 ≥ 对照上界减容许差、延迟上界 ≤ 对照下界、TPS 下界 ≥ 对照上界（至少速度指标之一严格改善），才给人工审阅范围。区间重叠、跨模型/协议/账号、样本不足、过期或截断均不会产生数值建议。不外推未测并发，不承诺最优并发，也不生成自动应用按钮。

## 代理与核心缺口

当前代理 current/trend/peak 直接来自实际 `network_proxy` 观测，不从账号配置猜代理，也不创造未观测代理的 zero series。核心 samples 没有对应 BLAKE3 identity；series.sample_ids 只是最多 8 个示例，不能据此生成无偏完整 outcome 统计。代理条目明确 `missing_complete_proxy_outcome_attribution`，recommendation=null。

核心后续需提供下列精确字段，仍只读、按租户隔离：

- completed request/outbound attempt 的稳定 proxy concurrency identity，算法与 series.identity 相同；实际 account、egress_attempt_id、开始/operational completion 时间；failover 的多 attempt 不可合为错误账号或错误代理。
- 与该 outcome 对齐的实测 exposure/采样点或可验证的稳定 attempt attribution；缺失与截断标记。不能仅回传 credential/代理组配置推断实际 endpoint。
- 如需从 owner-based 描述性范围推导供应商 wire 上限，还需真实 account/proxy HTTP exchange start/end、streaming、retry、credential/transport revision，以及模型负载可比信息；现在没有该证据，不声称已有。
- 安装态 host 私有 data adapter：同 providers:read + requests:read、固定授权 tenant、no-store；secret 不进入 guest config/UI/公开快照。

## 多臂老虎机

本次没有加入实验执行器，`experiment={enabled:false,state:disabled,...}` 明确返回原因。现有 host 没有独立实验账号/模型/预算执行契约，不能在客户流量上做隐式 exploration。若另行实现，必须显式启用并配置模型、账号、请求/token/费用/时间预算、停止与持久记录；保持客户流量原配置，输出仍只供人工应用。没有把所谓老虎机实现为硬编码并发阈值。

## 验证

fixture 覆盖可比较/不可比较区间、置信度与采样进度、usage 缺失失败分母、stale/truncated、代理缺口、双凭据隔离、固定租户、只读 GET、分页预算、body cap、重复 cursor/series、错误去敏。仅在既有 GHA `verify` 执行 npm check；本地没有 build/test/check/install。
