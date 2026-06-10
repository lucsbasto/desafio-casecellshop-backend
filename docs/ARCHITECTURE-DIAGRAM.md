# Diagramas de Arquitetura — CaseCellShop Backend

> Diagramas em [Mermaid](https://mermaid.js.org/) (renderizam no GitHub e no VS Code com a extensão *Markdown Preview Mermaid Support*). Complementam o [`DESIGN-PATTERNS.md`](./DESIGN-PATTERNS.md).

---

## 1. Visão Hexagonal (Ports & Adapters)

Cada *capability* de infra é um **port** (interface no `application/`) com **duas implementações** (in-memory e Redis/BullMQ), selecionadas em runtime por *factory* no `infrastructure.module.ts`. O domínio não conhece HTTP nem Redis.

```mermaid
flowchart LR
    subgraph DRIVING["🟦 Driving Side (entrada)"]
        direction TB
        HTTP["interface/http<br/>Controllers · DTOs · Guards<br/>Filters · Middleware"]
        SCHED["Schedulers<br/>@Interval reconcile"]
    end

    subgraph CORE["🟩 Núcleo da Aplicação (agnóstico de infra)"]
        direction TB
        subgraph UC["application/use-cases"]
            CHK["CheckoutUseCase"]
            WRK["CheckoutWorker"]
            REC["ReconcileUseCase"]
            LST["ListProductsUseCase"]
            GET["GetOrderStatusUseCase"]
        end
        subgraph DOM["domain (regras puras)"]
            ORD["Order + State Machine"]
            STK["Stock (tryReserve/release)"]
            PRD["Product / ProductView"]
            ERR["DomainError hierarchy"]
        end
        subgraph PORTS["application/ports (interfaces)"]
            P1(["CACHE_PORT"])
            P2(["STOCK_PORT"])
            P3(["IDEMPOTENCY_PORT"])
            P4(["QUEUE_PORT"])
            P5(["ORDER_REPO_PORT<br/>PRODUCT_REPO_PORT"])
            P6(["ERP_PORT"])
        end
    end

    subgraph DRIVEN["🟧 Driven Side (adapters de infra)"]
        direction TB
        A1["CacheAdapter<br/>redis ┆ in-memory"]
        A2["StockAdapter<br/>redis(Lua) ┆ in-memory"]
        A3["IdempotencyAdapter<br/>redis(Lua) ┆ in-memory"]
        A4["QueueAdapter<br/>BullMQ ┆ in-memory"]
        A5["Order/Product Repo<br/>in-memory Map"]
        A6["FakeErpClient"]
    end

    HTTP --> UC
    SCHED --> REC
    UC --> DOM
    UC --> PORTS

    P1 -.implements.-> A1
    P2 -.implements.-> A2
    P3 -.implements.-> A3
    P4 -.implements.-> A4
    P5 -.implements.-> A5
    P6 -.implements.-> A6

    A1 --> REDIS[("Redis")]
    A2 --> REDIS
    A3 --> REDIS
    A4 --> REDIS
    A6 --> ERPSYS["ERP externo<br/>(fake, lento/instável)"]

    classDef core fill:#d5f5e3,stroke:#27ae60,color:#145a32
    classDef driving fill:#d6eaf8,stroke:#2980b9,color:#1b4f72
    classDef driven fill:#fdebd0,stroke:#e67e22,color:#7e5109
    classDef port fill:#fff,stroke:#16a085,stroke-width:2px,color:#0e6655
    class CHK,WRK,REC,LST,GET,ORD,STK,PRD,ERR core
    class HTTP,SCHED driving
    class A1,A2,A3,A4,A5,A6 driven
    class P1,P2,P3,P4,P5,P6 port
```

**Leitura:** as setas sólidas vão de fora → núcleo → ports; as setas tracejadas (`implements`) mostram a *inversão de dependência* — a infra depende dos ports, nunca o contrário.

---

## 2. Fluxo de Checkout Assíncrono (caminho feliz + 202)

O request reserva estoque atomicamente, persiste `PENDING`, enfileira e responde **202** rápido. O faturamento no ERP acontece em background.

```mermaid
sequenceDiagram
    autonumber
    actor C as Cliente
    participant Ctl as CheckoutController
    participant UC as CheckoutUseCase
    participant Idem as IDEMPOTENCY_PORT
    participant Stk as STOCK_PORT
    participant Repo as ORDER_REPO_PORT
    participant Q as QUEUE_PORT
    participant W as CheckoutWorker
    participant Erp as ERP_PORT

    C->>Ctl: POST /checkout (Idempotency-Key)
    Ctl->>UC: execute(dto, key)
    UC->>Idem: remember(key) [Lua SET NX atômico]
    alt chave já vista
        Idem-->>UC: replay
        UC-->>C: 202 (pedido existente)
    else chave nova
        UC->>Stk: tryReserve(itens) [Lua CAS anti-oversell]
        Stk-->>UC: ok / InsufficientStock(409)
        UC->>Repo: save(Order = PENDING)
        UC->>Q: enqueue(CheckoutJob)
        UC-->>C: 202 Accepted (orderId)
    end

    Note over Q,W: processamento em background
    Q->>W: process(job)
    W->>Repo: transition PENDING→PROCESSING
    W->>Erp: invoice(order)
    alt sucesso
        Erp-->>W: ok
        W->>Repo: transition →CONFIRMED
    else falha (retry+backoff)
        Erp-->>W: erro
        W->>Q: re-tentar (exponential backoff)
        Note over W,Q: ao esgotar maxAttempts → onExhausted
        W->>Repo: transition →FAILED
        W->>Stk: release(itens) [compensação]
    end
```

---

## 3. Máquina de Estados do Pedido (`domain/order.ts`)

Transições válidas são definidas por construção; qualquer outra lança `InvalidOrderTransitionError`. A regra **PROCESSING nunca volta a PENDING** impede a reconciliação de re-enfileirar um pedido com worker ativo.

```mermaid
stateDiagram-v2
    [*] --> PENDING: checkout (estoque reservado)
    PENDING --> PROCESSING: worker pega o job
    PENDING --> FAILED: reconcile (órfão muito antigo) + release
    PROCESSING --> CONFIRMED: ERP faturou ✅
    PROCESSING --> FAILED: esgotou tentativas + release
    CONFIRMED --> [*]
    FAILED --> [*]

    note right of PROCESSING
        Estado terminal nunca transiciona.
        PROCESSING ↛ PENDING (anti double-processing).
    end note
```

---

## 4. Resiliência — Outbox lógico + Reconciliação + Compensação

Como não há transação distribuída (estoque em Redis, ERP externo, sem banco transacional), a consistência é mantida por **salvar-antes-de-enfileirar** + **reconciliação periódica** + **compensação de estoque**.

```mermaid
flowchart TD
    START([Checkout]) --> RES["Reserva estoque<br/>(Lua CAS)"]
    RES --> SAVE["Salva PENDING<br/>(source of truth)"]
    SAVE --> ENQ{"enqueue OK?"}
    ENQ -- sim --> PROC["Worker processa"]
    ENQ -- "não (falha)" --> ORPH["Pedido órfão PENDING"]

    SCHED["⏱️ @Interval 15s<br/>ReconcileScheduler"] --> SCAN["findPendingOlderThan"]
    SCAN --> ORPH
    ORPH --> DECIDE{"idade do pedido"}
    DECIDE -- "recente" --> REENQ["re-enqueue"] --> PROC
    DECIDE -- "muito antigo" --> FAILC["FAILED + release estoque"]

    PROC --> RETRY{"ERP ok?"}
    RETRY -- sim --> CONF["CONFIRMED"]
    RETRY -- "não" --> BACK["retry + backoff exponencial"]
    BACK --> EXH{"esgotou<br/>maxAttempts?"}
    EXH -- não --> PROC
    EXH -- sim --> COMP["onExhausted:<br/>FAILED + release<br/>(compensação) + DLQ"]

    classDef ok fill:#d5f5e3,stroke:#27ae60,color:#145a32
    classDef bad fill:#fadbd8,stroke:#c0392b,color:#7b241c
    classDef safe fill:#fdebd0,stroke:#e67e22,color:#7e5109
    class CONF,REENQ ok
    class FAILC,COMP bad
    class SCHED,SCAN,ORPH safe
```

---

## 5. Cache-Aside com proteção contra stampede (`ListProductsUseCase`)

```mermaid
flowchart LR
    REQ([GET /products]) --> GOL["CachePort.getOrLoad(key)"]
    GOL --> HIT{"hit no cache?"}
    HIT -- sim --> RET["retorna valor cacheado"]
    HIT -- "miss" --> SF{"loader já em voo?<br/>(single-flight)"}
    SF -- "sim" --> JOIN["aguarda a mesma execução<br/>(anti-stampede)"]
    SF -- "não" --> LOAD["roda loader → repo (40ms)"]
    LOAD --> OKL{"loader ok?"}
    OKL -- sim --> SET["grava com TTL + jitter"] --> RET
    OKL -- "não" --> STALE{"staleOnError?"}
    STALE -- sim --> LAST["serve lastKnown (stale)"]
    STALE -- "não" --> ERRO["propaga erro"]
    JOIN --> RET

    classDef ok fill:#d5f5e3,stroke:#27ae60,color:#145a32
    class RET,SET ok
```

---

## Legenda de cores

| Cor | Significado |
|-----|-------------|
| 🟦 Azul | Driving side — entrada (HTTP, schedulers) |
| 🟩 Verde | Núcleo da aplicação — use cases + domínio + ports (agnóstico de infra) |
| 🟧 Laranja | Driven side — adapters de infra (Redis/BullMQ/in-memory) |
| 🟥 Vermelho | Caminhos de falha / compensação |

> **Por que isto importa:** os diagramas tornam visível o princípio central do `DESIGN-PATTERNS.md` — toda dependência aponta *para dentro*, em direção ao domínio puro. É isso que permite trocar in-memory ↔ Redis sem tocar em uma linha de regra de negócio.
