# dsh-flight-compare

DSH 插件：注册 `flight_compare` 工具，从多个数据源获取单条航线的机票价格，按「航班号 + 出发日期」聚合，标出每个航班跨数据源的最低价及其来源，并按最低价升序输出 Markdown 表格。

数据源（见 `src/sources/`）：

| 数据源 | 接口 | 说明 |
| --- | --- | --- |
| Travelpayouts | `GET /v2/prices/month-matrix` | 缓存价格，支持整月查询，按城市 IATA 码查询 |
| Amadeus | `GET /v2/shopping/flight-offers` | 官方 Self-Service API 实时报价，按机场 IATA 码查询，需要 `YYYY-MM-DD` 具体日期 |

两个源都实现 `src/sources/types.ts` 里的 `FlightSource` 接口，统一返回 `Flight` 对象（航班号、航司、出发/到达、时间、价格、币种、来源）。某个源查询失败不会让整次调用失败，失败原因会在结果里列出。

## 安装

```bash
cd dsh-flight-compare
pnpm install
pnpm build
```

## 配置

凭据只从环境变量读取，不写进代码。Travelpayouts 必填；Amadeus 两项都留空时该源自动跳过，插件退化为单源比价：

```bash
export TRAVELPAYOUTS_TOKEN="<your-travelpayouts-token>"

# 可选：启用 Amadeus 第二个数据源
export AMADEUS_CLIENT_ID="<your-amadeus-api-key>"
export AMADEUS_CLIENT_SECRET="<your-amadeus-api-secret>"
export AMADEUS_PRODUCTION="false"   # true 时查询 api.amadeus.com
```

Amadeus Self-Service key 在 https://developers.amadeus.com 注册后自助创建，测试环境自带免费额度；测试环境是生产数据的子集，小城市可能查不到结果，建议先用大城市航线验证。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `travelpayoutsToken` | `process.env.TRAVELPAYOUTS_TOKEN` | Travelpayouts token，必填，作为 `X-Access-Token` 发送。 |
| `token` | 无 | 0.1.0 的旧字段名，作为 `travelpayoutsToken` 的兼容别名保留，两者同时存在时以 `travelpayoutsToken` 为准。 |
| `amadeusClientId` | `process.env.AMADEUS_CLIENT_ID` | Amadeus API key；与 secret 同时为空则该源不启用。 |
| `amadeusClientSecret` | `process.env.AMADEUS_CLIENT_SECRET` | Amadeus API secret，用于 OAuth2 client_credentials 取 token。 |
| `amadeusProduction` | `false` | `false` 用 `test.api.amadeus.com`，`true` 用 `api.amadeus.com`。 |
| `amadeusMaxResults` | `20` | 每次搜索向 Amadeus 请求的报价条数上限。 |
| `currency` | `RUB` | 价格币种，例如 `RUB`、`USD`；会作为 Amadeus 的 `currencyCode`。 |
| `maxRows` | `30` | 输出表格的最大行数。 |
| `timeoutMs` | `20000` | 每个数据源单次请求的超时时间（毫秒）。 |

覆盖默认值（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-flight-compare
      name: dsh-flight-compare
      config:
        travelpayoutsToken: !!js process.env.TRAVELPAYOUTS_TOKEN
        amadeusClientId: !!js process.env.AMADEUS_CLIENT_ID
        amadeusClientSecret: !!js process.env.AMADEUS_CLIENT_SECRET
        amadeusProduction: !!js process.env.AMADEUS_PRODUCTION === 'true'
        currency: USD
        maxRows: 30
```

`departDate` 传 `YYYY-MM-DD` 时两个源都会查；传 `YYYY-MM` 或不传时只有 Travelpayouts 参与比对（Amadeus 的搜索接口只接受单日），结果里会有一条说明。

## 本地调试

`--patch` 是 launcher 的 flag，必须跟在 `--profile` 之后（`dsh <name>` 是 `dsh --profile <name>` 的简写），补丁路径相对当前目录解析：

```bash
export TRAVELPAYOUTS_TOKEN="<your-travelpayouts-token>"
export AMADEUS_CLIENT_ID="<your-amadeus-api-key>"
export AMADEUS_CLIENT_SECRET="<your-amadeus-api-secret>"

# 在插件目录里启动当前 profile，并叠加这个补丁层
cd dsh-flight-compare
dsh --profile web --patch ./cordis.patch.yml
```

`--profile web` 换成实际要启动的 profile 名字即可（例如 `dsh tui --patch ./cordis.patch.yml`）。补丁里的 `name: dsh-flight-compare` 由 profile 的 `node_modules` 解析，所以先用 `dsh plugin --profile <profile> add <本目录绝对路径>` 把包装进 profile：

```bash
dsh plugin --profile web add "$(pwd)"
```

先确认组合结果再启动：

```bash
dsh --profile web --patch ./cordis.patch.yml --dump-config
```
