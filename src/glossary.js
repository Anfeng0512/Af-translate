/**
 * 计算机术语 / 黑话表。
 *
 * 不是逐词替换表，而是给模型看的「参考译法」：命中原文才随请求下发（最多 26 条），
 * 让模型按语境选词，既省 token 又不会把术语译歪。
 *
 * 格式：英文|中文|（可选）使用场景说明
 */
const RAW = `
out of the box|开箱即用
under the hood|底层实现上|描述内部机制
boilerplate|样板代码
boilerplate code|样板代码
gotcha|坑|容易踩的陷阱
breaking change|破坏性变更
edge case|边界情况
corner case|极端情况
happy path|正常路径|没有异常的主流程
golden path|推荐路径
pitfall|陷阱
caveat|注意事项
trade-off|权衡
workaround|变通方案
shim|兼容层
polyfill|polyfill（垫片）
wrapper|封装层
runtime|运行时
overhead|开销
hot path|热点路径
race condition|竞态条件
deadlock|死锁
starvation|饥饿|长期拿不到资源
memory leak|内存泄漏
dangling pointer|悬垂指针
null pointer|空指针
use-after-free|释放后使用
buffer overflow|缓冲区溢出
off-by-one|差一错误
undefined behavior|未定义行为
stack trace|调用栈信息
backtrace|回溯栈
core dump|核心转储
segfault|段错误
hot reload|热重载
hotfix|热修复
monkey patch|猴子补丁
deprecated|已弃用
sunset|停止支持
end-of-life|生命周期结束
migration|迁移
scaffold|脚手架
scaffolding|脚手架
linter|代码检查工具
formatter|格式化工具
bundler|打包器
tree shaking|tree shaking（摇树优化）
transpile|转译
codegen|代码生成
middleware|中间件
handler|处理函数
callback|回调
reducer|reducer
prop drilling|属性逐层透传
hydration|水合
server-side rendering|服务端渲染
client-side rendering|客户端渲染
static site generation|静态站点生成
incremental static regeneration|增量静态再生成
islands architecture|岛屿架构
serverless|无服务器
cold start|冷启动
debounce|防抖
throttle|节流
rate limit|速率限制
idempotent|幂等
eventual consistency|最终一致性
sharding|分片
replica|副本
failover|故障转移
load balancer|负载均衡器
reverse proxy|反向代理
cache invalidation|缓存失效
cache eviction|缓存淘汰
garbage collection|垃圾回收
heap allocation|堆分配
thread-safe|线程安全
lock-free|无锁
atomic|原子操作
optimistic locking|乐观锁
pessimistic locking|悲观锁
transaction|事务
rollback|回滚
idempotency key|幂等键
webhook|webhook（回调地址）
endpoint|端点
payload|载荷
schema|schema（数据结构定义）
seed data|种子数据
fixture|测试夹具
mock|模拟对象
stub|桩
flaky test|不稳定测试
regression|回归
smoke test|冒烟测试
canary release|金丝雀发布
blue-green deployment|蓝绿部署
feature flag|功能开关
gradual rollout|灰度发布
on-call|值班
postmortem|事故复盘
runbook|运维手册
observability|可观测性
distributed tracing|链路追踪
throughput|吞吐量
latency|延迟
benchmark|基准测试
LGTM|LGTM（看起来没问题）
nit|小意见
WIP|WIP（进行中）
tl;dr|太长不看|摘要
refactor|重构
chore|杂项
spike|技术预研
bikeshedding|纠结细枝末节
yak shaving|顺藤摸瓜的杂活
footgun|容易自伤的设计
escape hatch|兜底方案
leaky abstraction|有泄漏的抽象
idiomatic|符合惯用法
canonical|规范的
granular|细粒度
orthogonal|相互独立
side effect|副作用
pure function|纯函数
closure|闭包
hoisting|变量提升
prototype chain|原型链
event loop|事件循环
microtask|微任务
virtual DOM|虚拟 DOM
diffing|差异比对
memoization|记忆化
lazy loading|懒加载
eager loading|立即加载
streaming|流式
chunk|分块
backpressure|背压
heartbeat|心跳
keep-alive|保活
TLS termination|TLS 终止
CORS|跨域（CORS）
CSP|内容安全策略（CSP）
XSS|跨站脚本（XSS）
CSRF|跨站请求伪造（CSRF）
SSRF|服务端请求伪造（SSRF）
RCE|远程代码执行（RCE）
sandbox|沙箱
privilege escalation|权限提升
supply chain attack|供应链攻击
reproducible build|可复现构建
artifact|构建产物
provenance|来源证明
SBOM|软件物料清单（SBOM）
vendoring|依赖内置
monorepo|单体仓库（monorepo）
lockfile|锁文件
peer dependency|对等依赖
semver|语义化版本
prerelease|预发布
nightly build|每日构建
changelog|变更日志
release notes|发布说明
backport|回移（backport）
cherry-pick|拣选（cherry-pick）
squash|压缩提交
rebase|变基
merge conflict|合并冲突
upstream|上游
downstream|下游
staging area|暂存区
hunk|差异块
git blame|逐行追溯（blame）
git bisect|二分定位（bisect）
pull request|PR（拉取请求）
draft PR|草稿 PR
CI pipeline|CI 流水线
runner|运行器
cache hit|缓存命中
concurrency|并发
parallelism|并行
blocking|阻塞
non-blocking|非阻塞
coroutine|协程
daemon|守护进程
zombie process|僵尸进程
out of memory|内存耗尽
trampoline|蹦床
thunk|thunk（延迟求值）
currying|柯里化
destructuring|解构
optional chaining|可选链
nullish coalescing|空值合并
singleton|单例
factory|工厂
decorator|装饰器
generics|泛型
trait|trait（特征）
stack frame|栈帧
ABI|二进制接口（ABI）
FFI|外部函数接口（FFI）
syscall|系统调用
page fault|缺页
file descriptor|文件描述符
socket|套接字
loopback|回环地址
subnet|子网
TTL|存活时间（TTL）
DNS resolution|DNS 解析
round-robin|轮询
sticky session|会话保持
stateless|无状态
stateful|有状态
serialization|序列化
deserialization|反序列化
pagination|分页
cursor|游标
offset|偏移量
aggregation|聚合
query plan|查询计划
full table scan|全表扫描
isolation level|隔离级别
two-phase commit|两阶段提交
outbox pattern|发件箱模式
at-least-once|至少一次
exactly-once|恰好一次
backfill|回填
ETL|ETL（抽取-转换-加载）
scheduler|调度器
worker pool|工作线程池
fan-out|扇出
fan-in|扇入
circuit breaker|断路器
bulkhead|舱壁隔离
exponential backoff|指数退避
jitter|抖动
timeout|超时
graceful degradation|优雅降级
graceful shutdown|优雅关闭
warm-up|预热
health check|健康检查
liveness probe|存活探针
readiness probe|就绪探针
rolling update|滚动更新
sidecar|边车容器
init container|初始化容器
operator|Operator
CRD|自定义资源（CRD）
namespace|命名空间
pod|Pod
taint|污点
toleration|容忍
affinity|亲和性
horizontal pod autoscaler|水平 Pod 自动扩缩容
pod disruption budget|Pod 中断预算
fine-tuning|微调
quantization|量化
quantized|量化后的
inference|推理
context window|上下文窗口
embedding|嵌入
vector database|向量数据库
RAG|RAG（检索增强生成）
prompt|提示词
hallucination|幻觉
checkpoint|检查点
diffusion model|扩散模型
latent space|潜空间
sampler|采样器
random seed|随机种子
batch size|批大小
epoch|轮次
loss function|损失函数
gradient|梯度
backpropagation|反向传播
attention|注意力
multimodal|多模态
leaderboard|排行榜
VRAM|显存
GPU memory|显存
tokenizer|分词器
token|token
weight|权重
dataset|数据集
dataset card|数据集说明
inference server|推理服务
`;

export const GLOSSARY = RAW.trim()
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [en, zh, note] = line.split('|');
    return { en: en.trim(), zh: (zh || '').trim(), note: (note || '').trim() };
  })
  .filter((e) => e.en && e.zh);
