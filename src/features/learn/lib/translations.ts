// Copy for the /learn guide. Bilingual (en/es), keyed off the active language like
// the landing translations. Content only — no numbers copied by hand and no preset
// percentages, so it never drifts from src/content/portfolio-presets.ts (the portfolio cap is
// read from the pre-flight, D-476). Brand constraints: describe
// outcomes (withdraw anytime), never mention custody/Intents/solver — and never claim the
// funds "stay yours": while allocated they sit in the vault (ADR-0005, D-346) —
// and keep "not financial advice" as the ceiling on any claim.

import { appPortfolioCap } from "@/features/vault/lib/change-set-preflight";

type ListItem = { title: string; body: string };
type FaqItem = { q: string; a: string };

export const learnTranslations = {
  en: {
    meta: {
      title: "Guide",
      description:
        "How IntentFolio works, in plain language: targets, automatic rebalancing, presets, tips and answers to common questions.",
    },
    hero: {
      title: "How IntentFolio works",
      sub: "A plain-language walkthrough of targets, automatic rebalancing and what to expect — no jargon.",
    },
    index: {
      label: "On this page",
      items: [
        { id: "start-here", label: "Start here" },
        { id: "core-idea", label: "The core idea" },
        { id: "steps", label: "Step by step" },
        { id: "rebalancing", label: "What rebalancing does" },
        { id: "presets", label: "Presets, explained" },
        { id: "tips", label: "Tips" },
        { id: "faq", label: "FAQ" },
      ],
    },
    startHere: {
      id: "start-here",
      title: "Start here",
      tryTitle: "Try it without funds",
      tryBody:
        "You don't need to put in any funds to see how it works. Pick a preset or your own mix and see a simulation with a sample amount — no wallet needed. When you want to go for real, connect your wallet and deposit: your draft comes with you, and your portfolio is created when you assign funds to it.",
      audienceTitle: "Who it's for",
      audiences: [
        {
          title: "If you're just starting",
          body: "Pick a preset and that's it: you don't need to trade or know how swaps work.",
        },
        {
          title: "If you already know crypto",
          body: "Build your own mix, set the tolerance band for each token, and every move aims to leave you a spread in your favor.",
        },
        {
          title: "If you come from another network",
          body: "Sign in with your Ethereum, Solana, TON, Stellar or Tron wallet. No need to learn NEAR or create an account.",
        },
        {
          title: "If you hold crypto for the long term",
          body: "Keep a mix without watching charts. Once on target, it keeps aiming for a spread in your favor without leaving your band.",
        },
      ] as ListItem[],
    },
    coreIdea: {
      id: "core-idea",
      title: "The core idea",
      paragraphs: [
        "IntentFolio is built on one simple idea: you decide what mix of assets you want to hold, and your portfolio works to stay close to that mix on its own.",
        "Instead of watching charts and trading by hand, you set targets once — for example, how much of your portfolio should be in Bitcoin, Ethereum or stablecoins. From then on, the system keeps an eye on your allocation for you.",
        "From then on, your portfolio moves toward that mix on its own and, once there, keeps taking part in swaps without leaving your band. You stay in control of the rules; the routine work happens for you.",
      ],
    },
    steps: {
      id: "steps",
      title: "Step by step",
      intro: "From your first mix to a portfolio that moves toward your targets on its own, in four steps.",
      numbered: true,
      items: [
        {
          title: "Choose your allocation",
          body: "Start from a ready-made preset or build your own mix. For each asset you pick a target — the share of your portfolio you want it to hold — and a tolerance band, the range around that target that counts as on target.",
        },
        {
          title: "Connect and fund",
          body: "Sign in with any supported wallet — NEAR, Ethereum, Solana and more — and make your deposit. There's no account to create and no forms to fill out, and you can withdraw whenever you want.",
        },
        {
          title: "It moves toward your targets",
          body: "At the market's pace, through swaps that come up along the way, with no fees as it moves and no action needed from you. There's just a one-time storage cost when you create the portfolio. You can follow its progress in the app.",
        },
        {
          title: "Earn along the way",
          body: "Each move aims to leave you a spread in your favor. Once you reach your targets, your portfolio keeps taking part in swaps without leaving your band, and each one keeps aiming for that spread.",
        },
      ] as ListItem[],
    },
    rebalancing: {
      id: "rebalancing",
      title: "What rebalancing does",
      diagram: {
        targetLabel: "Target",
        bandLabel: "Tolerance band",
        buildingLabel: "On the way, swaps bring it closer",
        onTargetLabel: "Once on target, it stays inside the band",
        spreadLabel: "Each swap aims to leave you a spread in your favor",
      },
      paragraphs: [
        "Rebalancing is what moves your portfolio toward your mix: it takes part in swaps that come up in the market, and they bring it closer to your targets. You build it; rebalancing takes it the rest of the way.",
        "Your tolerance band is the range around each target that counts as on target. Once your portfolio is inside it, it doesn't stop: it keeps taking part in swaps, and none of them takes it out of the band.",
        "Each of those swaps aims to capture a spread in your favor, on the way to your targets and once you're there. Over time, they're meant to add up.",
      ],
      note: "Rebalancing only happens when you hold more than one asset. A portfolio made of a single token has nothing to rebalance against, so it simply stays as is.",
    },
    presets: {
      id: "presets",
      title: "Presets, explained",
      intro:
        "Presets are starting points, not recommendations — a quick way to begin that you can tweak however you like. They are not financial advice.",
      // D-569: the countries the app blocks stock buys in (stock-region.ts).
      stocksUnavailable: "Stocks aren't available in the United States or Canada.",
      items: [
        {
          title: "Tech Titans",
          body: "US tech stocks, tokenized: NVIDIA, Apple and Amazon, plus a Nasdaq-100 ETF. No crypto in the mix.",
        },
        {
          title: "NEAR + Stocks",
          body: "NEAR alongside tokenized stocks: NVIDIA, Apple and a Nasdaq-100 ETF. Crypto and stocks in one portfolio.",
        },
        {
          title: "Conservative",
          body: "Leans heavily on stablecoins, with a small share of Bitcoin and Ethereum. Built to move less when markets swing.",
        },
        {
          title: "Balanced",
          body: "A spread across major assets and stablecoins, aiming for a middle ground between calm and growth.",
        },
        {
          title: "Aggressive",
          body: "Concentrated in major assets like Bitcoin, Ethereum and Solana, with little held in stablecoins. More movement, both ways.",
        },
        {
          title: "Satoshi",
          body: "Bitcoin-forward, with a smaller share of Ethereum and NEAR alongside. For a clear tilt toward BTC.",
        },
      ] as ListItem[],
    },
    tips: {
      id: "tips",
      title: "Tips",
      items: [
        {
          title: "Wider bands, more spread",
          body: "Your tolerance band sets how far from each target your portfolio can sit and still count as on target. A wider band leaves more room to take part in swaps without leaving it, which means more chances to capture spread in your favor. A tighter band keeps your mix closer to your targets instead.",
        },
        {
          title: "Think in time horizons",
          body: "Automatic rebalancing rewards patience. The spreads it aims to capture add up gradually, so the approach fits people who plan to stay invested rather than trade in and out.",
        },
        {
          title: "More than one asset to rebalance",
          body: "Rebalancing needs at least two assets to work. If you want the system actively managing your mix, hold a few assets rather than a single token.",
        },
        {
          title: "You're always in control",
          body: "You can adjust your targets or withdraw whenever you want. Nothing is locked away.",
        },
      ] as ListItem[],
    },
    faq: {
      id: "faq",
      title: "Frequently asked questions",
      items: [
        {
          q: "Do I need to know about crypto to use IntentFolio?",
          a: "No. You pick a starting mix — or use a preset — and the system handles the day-to-day. The guide above covers everything you need to begin.",
        },
        {
          q: "Where are my funds? Are they locked up?",
          a: "What you deposit sits in your funding account, and what you add to a portfolio is managed there to keep your mix. Nothing is locked away — you can adjust your targets or withdraw whenever you want.",
        },
        {
          q: "Which wallets can I use?",
          a: "Any supported wallet, including NEAR, Ethereum, Solana, TON, Stellar and Tron. You sign in directly — there's no separate account to create.",
        },
        {
          q: "How do I choose my allocation?",
          a: "Start from one of the presets and adjust it, or build your own mix from scratch. For each asset you set a target share and a tolerance band.",
        },
        {
          q: "How many portfolios can I have?",
          a: `Up to ${appPortfolioCap()} per account, each with its own mix. To make room for another, delete one you no longer use.`,
        },
        {
          q: "What is a tolerance band?",
          a: "It's the range around each target that counts as on target. Once your portfolio is inside it, it keeps taking part in swaps, and none of them takes it out.",
        },
        {
          q: "What if I only hold one token?",
          a: "A single-token portfolio doesn't rebalance — there's nothing to balance it against. Rebalancing needs at least two assets, so hold a few if you want the system actively managing your mix.",
        },
        {
          q: "Is there a minimum to get started?",
          a: "IntentFolio doesn't set one: you start with whatever amount you choose. Some networks ask for a minimum deposit; you'll see it when you pick the network.",
        },
        {
          q: "Is this financial advice?",
          a: "No. IntentFolio is a tool for managing your own allocation, and presets are starting points, not recommendations. Crypto carries risk and prices can go down as well as up. Nothing here is financial advice.",
        },
        {
          q: "Can I withdraw whenever I want?",
          a: "Yes. You can withdraw at any time. Stocks are the exception: you sell them for USDC first, and that can wait while their market is closed.",
        },
      ] as FaqItem[],
    },
    backToHome: "Back to home",
  },
  es: {
    meta: {
      title: "Guía",
      description:
        "Cómo funciona IntentFolio, en lenguaje simple: objetivos, rebalanceo automático, presets, tips y respuestas a las dudas más comunes.",
    },
    hero: {
      title: "Cómo funciona IntentFolio",
      sub: "Una explicación en lenguaje simple sobre objetivos, rebalanceo automático y qué esperar — sin tecnicismos.",
    },
    index: {
      label: "En esta página",
      items: [
        { id: "start-here", label: "Para empezar" },
        { id: "core-idea", label: "La idea central" },
        { id: "steps", label: "Paso a paso" },
        { id: "rebalancing", label: "Qué hace el rebalanceo" },
        { id: "presets", label: "Los presets, explicados" },
        { id: "tips", label: "Tips" },
        { id: "faq", label: "Preguntas frecuentes" },
      ],
    },
    startHere: {
      id: "start-here",
      title: "Para empezar",
      tryTitle: "Pruébalo sin poner fondos",
      tryBody:
        "No hace falta poner fondos para ver cómo funciona. Elige un preset o tu propia mezcla y mira una simulación con un monto de ejemplo, sin conectar ninguna wallet. Cuando quieras hacerlo en serio, conecta tu wallet y deposita: tu borrador te acompaña, y el portfolio se crea cuando le asignas fondos.",
      audienceTitle: "Para quién es",
      audiences: [
        {
          title: "Si estás empezando",
          body: "Elige un preset y listo: no necesitas operar ni saber cómo funcionan los swaps.",
        },
        {
          title: "Si ya conoces cripto",
          body: "Arma tu propia mezcla, define la banda de tolerancia de cada token, y cada movimiento busca dejarte un spread a favor.",
        },
        {
          title: "Si vienes de otra red",
          body: "Ingresa con tu wallet de Ethereum, Solana, TON, Stellar o Tron. No necesitas aprender NEAR ni crear una cuenta.",
        },
        {
          title: "Si guardas cripto a largo plazo",
          body: "Mantén una mezcla sin mirar gráficos. Una vez en objetivo, sigue buscando un spread a favor sin salir de tu banda.",
        },
      ] as ListItem[],
    },
    coreIdea: {
      id: "core-idea",
      title: "La idea central",
      paragraphs: [
        "IntentFolio se basa en una idea simple: tú decides qué mezcla de activos quieres tener, y tu portfolio trabaja para mantenerse cerca de esa mezcla solo.",
        "En lugar de mirar gráficos y operar a mano, defines tus objetivos una vez — por ejemplo, cuánto de tu portfolio quieres en Bitcoin, Ethereum o stablecoins. A partir de ahí, el sistema vigila tu composición por ti.",
        "A partir de ahí, tu portfolio va hacia esa mezcla solo y, cuando llega, sigue participando en swaps sin salir de tu banda. Tú mantienes el control de las reglas; el trabajo repetitivo pasa solo.",
      ],
    },
    steps: {
      id: "steps",
      title: "Paso a paso",
      intro: "De tu primera mezcla a un portfolio que avanza solo hacia tus objetivos, en cuatro pasos.",
      numbered: true,
      items: [
        {
          title: "Eliges tu composición",
          body: "Empiezas con un preset listo o armas tu propia mezcla. Para cada activo eliges un objetivo — la porción de tu portfolio que quieres que ocupe — y una banda de tolerancia, el margen alrededor de ese objetivo dentro del cual se considera que llegaste.",
        },
        {
          title: "Conectas y depositas",
          body: "Ingresas con cualquier wallet soportada — NEAR, Ethereum, Solana y más — y haces tu depósito. No hay cuenta que crear ni formularios que llenar, y retiras cuando quieras.",
        },
        {
          title: "Avanza hacia tus objetivos",
          body: "Al ritmo del mercado, con swaps que van surgiendo en el camino, sin comisiones en los movimientos y sin que hagas nada. Sólo hay un costo único de almacenamiento al crear el portfolio. El avance lo ves en la app.",
        },
        {
          title: "Ganas en el camino",
          body: "Cada movimiento busca dejarte un spread a favor. Cuando llegas a tus objetivos, tu portfolio sigue participando en swaps sin salir de tu banda, y cada uno lo sigue buscando.",
        },
      ] as ListItem[],
    },
    rebalancing: {
      id: "rebalancing",
      title: "Qué hace el rebalanceo",
      diagram: {
        targetLabel: "Objetivo",
        bandLabel: "Banda de tolerancia",
        buildingLabel: "En el camino, los swaps lo acercan",
        onTargetLabel: "Ya en objetivo, no sale de la banda",
        spreadLabel: "Cada swap busca dejarte un spread a favor",
      },
      paragraphs: [
        "El rebalanceo es lo que lleva tu portfolio hacia tu mezcla: participa en swaps que surgen en el mercado, y esos swaps lo van acercando a tus objetivos. Tú lo armas; el rebalanceo lo lleva el resto del camino.",
        "Tu banda de tolerancia es el margen alrededor de cada objetivo dentro del cual se considera que llegaste. Una vez adentro, tu portfolio no se detiene: sigue participando en swaps, y ninguno lo saca de la banda.",
        "Cada uno de esos swaps busca capturar un spread a tu favor, en el camino hacia tus objetivos y una vez que llegaste. Con el tiempo, la idea es que se acumulen.",
      ],
      note: "El rebalanceo solo ocurre cuando tienes más de un activo. Un portfolio armado con un único token no tiene contra qué rebalancear, así que simplemente queda como está.",
    },
    presets: {
      id: "presets",
      title: "Los presets, explicados",
      intro:
        "Los presets son puntos de partida, no recomendaciones — una forma rápida de empezar que puedes ajustar como quieras. No son asesoramiento financiero.",
      stocksUnavailable: "Las acciones no están disponibles en Estados Unidos ni Canadá.",
      items: [
        {
          title: "Tech Titans",
          body: "Acciones tecnológicas de EE. UU., tokenizadas: NVIDIA, Apple y Amazon, más un ETF del Nasdaq-100. Sin cripto en la mezcla.",
        },
        {
          title: "NEAR + Acciones",
          body: "NEAR junto a acciones tokenizadas: NVIDIA, Apple y un ETF del Nasdaq-100. Cripto y acciones en un mismo portfolio.",
        },
        {
          title: "Conservador",
          body: "Se apoya fuerte en stablecoins, con una porción pequeña de Bitcoin y Ethereum. Pensado para moverse menos cuando el mercado se sacude.",
        },
        {
          title: "Equilibrado",
          body: "Un reparto entre activos principales y stablecoins, buscando un punto medio entre calma y crecimiento.",
        },
        {
          title: "Agresivo",
          body: "Concentrado en activos principales como Bitcoin, Ethereum y Solana, con poco en stablecoins. Más movimiento, para los dos lados.",
        },
        {
          title: "Satoshi",
          body: "Con foco en Bitcoin, acompañado por una porción menor de Ethereum y NEAR. Para una inclinación clara hacia BTC.",
        },
      ] as ListItem[],
    },
    tips: {
      id: "tips",
      title: "Tips",
      items: [
        {
          title: "Bandas más amplias, más spread",
          body: "Tu banda de tolerancia define qué tan lejos de cada objetivo puede estar tu portfolio y seguir contando como «en objetivo». Una banda más amplia deja más margen para participar en swaps sin salir de ella: más oportunidades de capturar spread a tu favor. Una más ajustada mantiene tu mezcla más cerca de tus objetivos.",
        },
        {
          title: "Piensa en horizontes de tiempo",
          body: "El rebalanceo automático premia la paciencia. Los spreads que busca capturar se acumulan de a poco, así que el enfoque le sirve a quien planea quedarse invertido más que entrar y salir.",
        },
        {
          title: "Más de un activo para rebalancear",
          body: "El rebalanceo necesita al menos dos activos para funcionar. Si quieres que el sistema gestione tu mezcla activamente, ten varios activos en lugar de un solo token.",
        },
        {
          title: "Siempre tienes el control",
          body: "Puedes ajustar tus objetivos o retirar cuando quieras. Nada queda bloqueado.",
        },
      ] as ListItem[],
    },
    faq: {
      id: "faq",
      title: "Preguntas frecuentes",
      items: [
        {
          q: "¿Necesito saber de cripto para usar IntentFolio?",
          a: "No. Eliges una mezcla inicial — o usas un preset — y el sistema se encarga del día a día. La guía de arriba cubre todo lo que necesitas para empezar.",
        },
        {
          q: "¿Dónde están mis fondos? ¿Quedan bloqueados?",
          a: "Lo que depositas queda en tu cuenta de fondos, y lo que asignas a un portfolio se gestiona ahí para mantener tu mezcla. Nada queda bloqueado — puedes ajustar tus objetivos o retirar cuando quieras.",
        },
        {
          q: "¿Qué wallets puedo usar?",
          a: "Cualquier wallet soportada, incluyendo NEAR, Ethereum, Solana, TON, Stellar y Tron. Ingresas directamente — no hay una cuenta aparte que crear.",
        },
        {
          q: "¿Cómo elijo mi composición?",
          a: "Empiezas con uno de los presets y lo ajustas, o armas tu propia mezcla desde cero. Para cada activo defines una porción objetivo y una banda de tolerancia.",
        },
        {
          q: "¿Cuántos portfolios puedo tener?",
          a: `Hasta ${appPortfolioCap()} por cuenta, cada uno con su propia mezcla. Para hacer lugar a otro, elimina uno que ya no uses.`,
        },
        {
          q: "¿Qué es una banda de tolerancia?",
          a: "Es el margen alrededor de cada objetivo dentro del cual se considera que llegaste. Una vez adentro, tu portfolio sigue participando en swaps, y ninguno lo saca.",
        },
        {
          q: "¿Y si tengo un solo token?",
          a: "Un portfolio de un único token no se rebalancea — no hay contra qué balancearlo. El rebalanceo necesita al menos dos activos, así que ten varios si quieres que el sistema gestione tu mezcla activamente.",
        },
        {
          q: "¿Hay un mínimo para empezar?",
          a: "IntentFolio no pone uno: empiezas con el monto que elijas. Algunas redes piden un depósito mínimo; lo ves al elegir la red.",
        },
        {
          q: "¿Esto es asesoramiento financiero?",
          a: "No. IntentFolio es una herramienta para gestionar tu propia composición, y los presets son puntos de partida, no recomendaciones. La cripto conlleva riesgo y los precios pueden bajar tanto como subir. Nada aquí es asesoramiento financiero.",
        },
        {
          q: "¿Puedo retirar cuando quiera?",
          a: "Sí. Puedes retirar en cualquier momento. Los stocks son la excepción: primero se venden por USDC, y eso puede tener que esperar si su mercado está cerrado.",
        },
      ] as FaqItem[],
    },
    backToHome: "Volver al inicio",
  },
} as const;
