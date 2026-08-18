<details>
<summary><b>🌐 Languages</b></summary>

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

</details>

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistema de ingeniería de bucles de AI Agent local, autoalojado y multiusuario (escritorio + navegador + móvil) / Impulsado por AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/releases"><img src="https://img.shields.io/github/v/release/AIGeniusInstitute/deepthink?style=for-the-badge&color=blue&label=Release" alt="Latest Release" /></a>
  <a href="https://github.com/AIGeniusInstitute/deepthink/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/AIGeniusInstitute/deepthink/release.yml?branch=main&style=for-the-badge&label=Build" alt="Build Status" /></a>
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deepthink?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## ¿Qué es DeepThink?

DeepThink, una plataforma de auto-evolución de superinteligencia Agent autónoma de nivel empresarial, pionera en la transición del paradigma Harness Engineering al Loop Engineering, es la nueva generación de Infraestructura de IA (AI Infra) para clientes empresariales. La plataforma DeepThink se centra en un marco de colaboración multi-Agent, fusionando AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop y Human-Agent Symbiosis para construir un sistema de IA empresarial que aprende continuamente, se auto-mejora y, en última instancia, crece hasta convertirse en una superinteligencia:

- **Plataforma de I+D Autónoma con IA** — Los Agent completan de forma independiente el ciclo de vida completo del desarrollo de software, sin necesidad de ingenieros humanos en tareas de codificación rutinarias
- **Motor de Agent Auto-Evolutivo** — Los Agent aprenden continuamente de los errores, absorben conocimiento del código base y evolucionan a partir de los comentarios de los usuarios
- **Centro de Colaboración Programador-Agent** — Cada programador posee un "Proyecto de Desarrollo" personal con múltiples sesiones paralelas, y un planificador central evita conflictos de concurrencia
- **Plataforma SaaS Empresarial** — Aislamiento multi-tenant, permisos por niveles, facturación elástica e integraciones empresariales (Feishu/DingTalk/WeCom/LDAP)
- **Incubadora de Superinteligencia** — Mediante evolución continua, un solo Agent alcanza finalmente las capacidades integrales de un equipo de software completo

> "Que cada empresa tenga un equipo de I+D súper de IA que nunca se detiene y evoluciona continuamente — del usuario de herramientas, al creador de código, creciendo finalmente hacia una superinteligencia auto-replicante. Caminemos juntos en el camino hacia AGI."

### Características clave

- **Nativamente impulsado por Claude Code** — Basado en Claude Agent SDK, el runtime subyacente es el CLI completo de Claude Code, heredando todas sus capacidades
- **Harness & Loop Engineering** — Manifests de harness versionados (system prompt / subagents / tools / skills) con snapshot / diff / eval / promote / rollback, más bucles de tareas autónomas de larga duración con revisión por iteración y reinyección de fallos
- **Autonomy Layer y Autonomous Mode** *(v1.1.0)* — Una Autonomy Layer transversal unifica las 7 capacidades (perception / cognition / decision / execution / learning / adaptation / monitoring) con metrics collection y E2E acceptance; más un Autonomous Mode completo que permite al Agent completar una tarea end-to-end sin supervisión humana, cubriendo three defense layers (CLAUDE.md anulación constitucional / Supervisor omisión de clarificación / RLHF cortesía de fin de turno) y four hard brakes (comandos destructivos / límite de turnos / límite de tokens / detección de bucle)
- **Agent-as-a-Service (PaaS)** — Definiciones de Agent respaldadas en DB: crear, versionar, montar, compartir e instalar entre tenants, con cuotas por usuario, revisión admin y un marketplace de plantillas publicables
- **Aislamiento multiusuario** — Workspace por usuario, canales IM por usuario, RBAC, registro por código de invitación, logs de auditoría
- **Enrutamiento unificado de ocho canales** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp e interfaz Web — todos enrutados de forma uniforme
- **Multi-Engine y Multi-Provider** — Motores de code-agent pluggables (Claude Code / AtomCode / Codex / OpenCode) y múltiples proveedores de Claude API con tres estrategias de balanceo (round-robin / weighted / failover), detección automática de salud
- **Ejecución de código en sandbox** — Sandbox reforzado con Docker + seccomp + cgroups para ejecución de código Python / Node / shell y automatización de navegador Chromium CDP
- **Billing y estadísticas de uso** — Sistema completo de facturación (planes de suscripción, saldo de wallet, códigos de canje), trazabilidad de tokens por modelo y gráficos
- **PWA móvil** — Profundamente optimizado para móvil, instalación de un clic en el escritorio, iOS y Android adaptados
- **Internacionalizado** — 29 idiomas de UI con endónimos nativos y soporte RTL; el Agent responde en el idioma elegido por el usuario

## Vitrine de funcionalidades

Un recorrido visual por las capacidades centrales de DeepThink — el aspecto de cada pantalla y el valor que aporta al usuario.

| Captura de pantalla | Funcionalidad | Características principales | Qué significa para ti |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Espacio de trabajo principal** | Pestañas multi-conversación, Markdown en streaming, panel de razonamiento en tiempo real, trazado de llamadas a herramientas | Un único espacio de trabajo alberga muchos chats en paralelo — cambia de contexto sin perder estado, observa al Agent pensar y actuar en directo |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Crea / versiona / monta definiciones de Agent personalizadas, preflight de capacidades del host, gestión de snapshots | Define tus propios Agentes especializados (code-reviewer, web-researcher, …) y reutilízalos en cada sesión |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Editor de Agent** | Edita `~/.claude/agents/*.md` desde la Web UI, system-prompt + herramientas + subagentes en un único formulario | Ajusta el comportamiento de un Agent en lenguaje llano — sin rebuscar en archivos, los cambios se aplican en la próxima sesión |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Prueba de Agent** | Ejecuta un Agent contra entradas de muestra antes de publicarlo, inspecciona la traza completa de salida | Publica Agentes con confianza — verifica el comportamiento en casos de prueba antes de dejarlos sueltos en producción |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Multi-Engine** | Motores conectables (Claude Code / AtomCode / Codex / OpenCode), panel unificado de disponibilidad | Elige el mejor cerebro para cada tarea — cambia de motor por sesión sin re-arquitecturar la plataforma |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Configuración de motor** | Ciclo de vida del daemon por motor, credenciales de proveedor, estado de salud de un vistazo | Ejecuta varios proveedores en paralelo — añade credenciales, monitoriza la disponibilidad y conmuta automáticamente ante fallos |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Motor AtomCode** | Daemon HTTP/SSE independiente, puerto loopback por agent-runner, auto-teardown | Usa AtomCode como motor de codificación alternativo — daemon aislado por proceso, sin conflictos de puertos |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Plantillas publicables por el admin (agent / mcp / skill / kb), explorar, valorar, instalar con un clic | Descubre e instala Agentes y herramientas compartidas como en una tienda de apps — los admins curan, los usuarios instalan con un clic |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **Servidores MCP** | Servidores MCP stdio + HTTP por workspace, independientes de la configuración global | Dale a cada workspace su propio conjunto de herramientas — conecta Notion, GitHub, bases de datos… acotado exactamente a ese proyecto |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills a nivel de proyecto / usuario / workspace, autodescubiertas vía volume mounts + symlinks | Enseña al Agent nuevos trucos por proyecto — sin reconstruir imagen, las skills aparecen en la próxima sesión |
| <img src="static/deep-think-memory.png" width="280" /> | **Sistema de memoria** | Memoria de usuario global / de sesión / por fecha, búsqueda de texto completo, edición en línea | El Agent te recuerda entre sesiones — recupera preferencias, contexto de proyecto y decisiones sin tener que reexplicarlas |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Tareas programadas** | Cron / intervalo / una sola vez, ejecución Agent o Script, contexto de grupo o aislado, notificación por IM al completar | Automatiza tareas recurrentes — informes nocturnos, comprobaciones periódicas, bucles autónimos que te avisan por Feishu/Telegram al terminar |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Ejecución en Sandbox** | Docker + seccomp + cgroups, código Python / Node / shell, automatización de navegador con Chromium CDP | Deja que el Agent ejecute código no fiable y conduzca un navegador de forma segura — aislamiento reforzado, expuesto como herramientas MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Monitor del sistema** | Lista de contenedores, estado de la cola, sesiones activas por proveedor, health checks, construcción de imagen con un clic | Ve exactamente qué se está ejecutando — detecta contenedores atascados, equilibra la carga y reconstruye imágenes desde el navegador |
| <img src="static/deep-think-tokens.png" width="280" /> | **Uso y facturación** | Desglose de tokens por modelo (entrada / salida / caché), coste en USD, gráficos de barras + circulares, filtros multidimensionales | Sabe a dónde van tus tokens y tu dinero — filtra por usuario, modelo y rango de fechas, factura a los equipos con precisión |
| <img src="static/deep-think-about.png" width="280" /> | **Acerca de** | Versión, info de build, enlaces del proyecto, comprobación de actualizaciones con un clic | Mantente al día — consulta tu versión de build y salta directamente a docs, repo y canales de actualización |

## Inicio rápido

### Requisitos previos

**Obligatorio**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (para modo contenedor; el admin en modo host no lo necesita), y una clave API de Claude (Anthropic oficial o servicio de retransmisión compatible).

**Opcional**: credenciales de Feishu, Telegram Bot Token, credenciales de QQ Bot, credenciales de DingTalk, token de WeChat iLink, Discord Bot Token y WhatsApp (escaneo de QR al primer arranque) — solo si quieres integraciones IM.

> No necesitas instalar Claude Code CLI manualmente — el Claude Agent SDK del proyecto ya incluye el runtime completo del CLI, se instala automáticamente al ejecutar `make start` por primera vez.

### Instalación y arranque

```bash
# 1. Clonar el repositorio
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Inicio con un solo comando (instala dependencias y compila la primera vez)
make start
```

Visita http://localhost:9898 y sigue el asistente de configuración: crea el administrador (sin cuenta por defecto), configura la API de Claude y, opcionalmente, los canales IM. Toda la configuración se hace desde la interfaz Web, sin archivos de configuración. Las claves API se almacenan cifradas con AES-256-GCM.

### Modo contenedor

El usuario admin usa por defecto el modo host (sin Docker), listo para usar. Si necesitas modo contenedor (los usuarios member lo usan automáticamente tras registrarse):

```bash
./container/build.sh
```

Tras el registro, cada nuevo usuario obtiene automáticamente un workspace principal en modo contenedor (`home-{userId}`), sin configuración adicional.

## Visión general de la arquitectura


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink se compone de cuatro proyectos Node.js independientes:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): servicio principal con router de mensajes (polling de 2s + dedupe), cola de concurrencia (hasta 20 contenedores + 5 procesos host), scheduler de tareas (cron / interval / once), servidor WebSocket para streaming en tiempo real y terminal, autenticación con bcrypt + HMAC Cookie, RBAC y gestión de configuración cifrada AES-256-GCM. Persistencia en SQLite (modo WAL, esquema v1→v51). También incluye las capas de Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox y Claude Code Plugins.
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4, con react-markdown, mermaid, recharts, xterm.js y PWA móvil.
- **Agent Runner** (`container/agent-runner/`): motor de ejecución que corre dentro de un contenedor Docker o como proceso host; invoca el `query()` del Claude Agent SDK, emite más de 30 tipos de StreamEvent vía stdout, y expone 27 herramientas MCP al proceso principal mediante canales IPC basados en archivos con escritura atómica.
- **Desktop** (`desktop/`): shell de Electron que empaqueta una app standalone para macOS / Windows / Linux.

Los ocho canales IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entran por el router, se desduplican y se enrután a la cola, que a través del ProviderPool selecciona la clave API / engine y arranca el contenedor, proceso host o sandbox. Los eventos de streaming se emiten por WebSocket al cliente Web o se responden por las APIs IM a cada canal.

## Documentación completa

Para la guía completa, consulta:

- [Versión completa en inglés](README.md)
- [Versión completa en 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)


## About Author

- [AI光剑的博客](https://blog.csdn.net/universsky2015)

- [Github](https://github.com/AIGeniusInstitue)

- [光剑图书馆: 全球免费开放的电子图书馆 World Free eBook](https://universsky.github.io/)


---

## 捐赠

> Donate to AI Genius Institute:


| 微信                                                    | 支付宝                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| <img src="static/wechat.jpeg" width="300" height="350"> | <img src="static/alipay.jpeg" width="300" height="350"> |
