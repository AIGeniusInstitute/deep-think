<details>
<summary><b>🌐 Languages</b></summary>

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

</details>

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Système auto-hébergé multi-utilisateur d'ingénierie de boucles d'AI Agent local (bureau + navigateur + mobile) / Propulsé par AI Genius Institute
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


## Qu'est-ce que DeepThink ?

DeepThink, une plateforme d'auto-évolution de superintelligence Agent autonome de niveau entreprise, pionnière dans la transition du paradigme Harness Engineering vers Loop Engineering, est la nouvelle génération d'Infrastructure IA (AI Infra) pour les clients entreprise. La plateforme DeepThink s'articule autour d'un framework de collaboration multi-Agent, fusionnant AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop et Human-Agent Symbiosis pour bâtir un système d'IA d'entreprise qui apprend continuellement, s'auto-améliore et, in fine, se développe pour devenir une superintelligence :

- **Plateforme de R&D Autonome par IA** — Les Agent accomplissent indépendamment le cycle de vie complet de développement logiciel, sans nécessiter d'ingénieurs humains pour les tâches de codage routinières
- **Moteur Agent Auto-Évolutif** — Les Agent apprennent continuellement des erreurs, absorbent le savoir de la base de code et évoluent à partir des retours utilisateurs
- **Hub de Collaboration Programmateur-Agent** — Chaque programmateur possède un « Projet de Développement » personnel contenant plusieurs sessions parallèles, et un planificateur central empêche les conflits de concurrence
- **Plateforme SaaS d'Entreprise** — Isolation multi-tenant, permissions hiérarchisées, facturation élastique et intégrations d'entreprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubateur de Superintelligence** — Par l'évolution continue, un Agent unique finit par acquérir les capacités globales d'une équipe logicielle complète

> « Que chaque entreprise possède une super-équipe de R&D IA qui ne s'arrête jamais et évolue continuellement — de l'utilisateur d'outils, au créateur de code, pour finalement devenir une superintelligence auto-répliquante. Marchons ensemble sur la voie de l'AGI. »

### Caractéristiques clés

- **Nativement propulsé par Claude Code** — Basé sur Claude Agent SDK, le runtime sous-jacent est la CLI complète de Claude Code, héritant de toutes ses capacités
- **Harness & Loop Engineering** — Manifests d'harness versionnés (prompt système / subagents / outils / skills) avec snapshot / diff / eval / promote / rollback, plus des boucles de tâches autonomes longues avec revue par itération et réinjection des échecs
- **Autonomy Layer et Autonomous Mode** *(v1.1.0)* — Une Autonomy Layer transversale unifie les 7 capacités (perception / cognition / decision / execution / learning / adaptation / monitoring) avec metrics collection et E2E acceptance ; plus un Autonomous Mode complet qui permet à l'Agent de terminer une tâche end-to-end sans assistance humaine, couvrant three defense layers (CLAUDE.md override constitutionnel / Supervisor contournement de clarification / RLHF politesse de fin de tour) et four hard brakes (commandes destructives / limite de tours / limite de tokens / détection de boucle)
- **Agent-as-a-Service (PaaS)** — Création, versionnement, montage, partage et installation de définitions d'Agent stockées en base à travers les tenants, avec quotas par utilisateur, revue admin et un marketplace de templates publiable
- **Isolation multi-utilisateur** — Workspace par utilisateur, canaux IM par utilisateur, système de permissions RBAC, inscription par code d'invitation et journaux d'audit
- **Routage unifié sur huit canaux** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp et l'interface Web — tous routés uniformément
- **Multi-moteur et multi-fournisseurs** — Moteurs de code-agent pluguables (Claude Code / AtomCode / Codex / OpenCode) et plusieurs fournisseurs d'API Claude avec trois stratégies d'équilibrage (round-robin / weighted / failover) et détection de santé automatique
- **Exécution de code sandboxée** — Sandbox Docker + seccomp + cgroups durci pour l'exécution de code Python / Node / shell et l'automatisation de navigateur Chromium CDP
- **Facturation et statistiques d'usage** — système complet de facturation (plans d'abonnement, portefeuille, codes de remboursement), suivi des tokens par modèle et graphiques de visualisation
- **PWA mobile** — profondément optimisé pour le mobile, installation en un clic sur le bureau, iOS / Android adaptés
- **Internationalisé** — 29 langues d'interface avec endonymes natifs et support RTL ; l'Agent répond dans la langue choisie par l'utilisateur

## Vitrine des fonctionnalités

Une visite visuelle des capacités clés de DeepThink — à quoi ressemble chaque écran et la valeur qu'il apporte à l'utilisateur.

| Capture d'écran | Fonctionnalité | Points clés | Ce que cela signifie pour vous |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Espace de travail principal** | Onglets multi-conversations, Markdown en streaming, panneau de raisonnement en temps réel, traçage des appels d'outils | Un seul espace de travail regroupe de nombreux chats en parallèle — changez de contexte sans perdre l'état, regardez l'Agent penser et agir en direct |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Créer / versionner / monter des définitions d'Agent personnalisées, préflight des capacités du host, gestion de snapshots | Définissez vos propres Agents spécialisés (code-reviewer, web-researcher, …) et réutilisez-les dans chaque session |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Éditeur d'Agent** | Éditez `~/.claude/agents/*.md` depuis la Web UI, system-prompt + outils + sous-agents dans un seul formulaire | Ajustez le comportement d'un Agent en langage clair — pas de fouille dans les fichiers, les changements s'appliquent à la prochaine session |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Test d'Agent** | Exécutez un Agent sur des entrées d'exemple avant publication, inspectez la trace complète de sortie | Livrez vos Agents en confiance — vérifiez le comportement sur des cas de test avant de les laisser en production |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Multi-Engine** | Moteurs enfichables (Claude Code / AtomCode / Codex / OpenCode), tableau de bord unifié de disponibilité | Choisissez le meilleur cerveau pour chaque tâche — changez de moteur par session sans ré-architecturer la plateforme |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Configuration du moteur** | Cycle de vie du daemon par moteur, identifiants du fournisseur, état de santé en un coup d'œil | Exécutez plusieurs fournisseurs côte à côte — ajoutez des identifiants, surveillez la disponibilité et basculez automatiquement en cas de panne |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Moteur AtomCode** | Daemon HTTP/SSE autonome, port loopback par agent-runner, auto-teardown | Utilisez AtomCode comme moteur de codage alternatif — daemon isolé par processus, sans conflits de port |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Modèles publiable par l'admin (agent / mcp / skill / kb), parcours, notation, installation en un clic | Découvrez et installez des Agents et outils partagés comme sur un App Store — les admins sélectionnent, les utilisateurs installent en un clic |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **Serveurs MCP** | Serveurs MCP stdio + HTTP par workspace, indépendants de la configuration globale | Donnez à chaque workspace son propre jeu d'outils — connectez Notion, GitHub, des bases de données… exactement ciblé sur ce projet |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills au niveau projet / utilisateur / workspace, auto-découvertes via volume mounts + symlinks | Apprenez de nouveaux tours à l'Agent par projet — pas de rebuild d'image, les skills apparaissent à la prochaine session |
| <img src="static/deep-think-memory.png" width="280" /> | **Système de mémoire** | Mémoire utilisateur globale / de session / par date, recherche en texte intégral, édition en ligne | L'Agent se souvient de vous entre les sessions — retrouvez préférences, contexte de projet et décisions sans ré-expliquer |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Tâches planifiées** | Cron / intervalle / ponctuel, exécution Agent ou Script, contexte de groupe ou isolé, notification IM à la fin | Automatisez le travail récurrent — rapports nocturnes, vérifications périodiques, boucles autonomes qui vous pinguent sur Feishu/Telegram une fois terminées |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Exécution en Sandbox** | Docker + seccomp + cgroups, code Python / Node / shell, automatisation navigateur via Chromium CDP | Laissez l'Agent exécuter du code non fiable et piloter un navigateur en toute sécurité — isolation renforcée, exposée comme outils MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Moniteur système** | Liste des conteneurs, état de la file, sessions actives par fournisseur, health checks, build d'image en un clic | Voyez exactement ce qui tourne — repérez les conteneurs bloqués, équilibrez la charge et reconstruisez les images depuis le navigateur |
| <img src="static/deep-think-tokens.png" width="280" /> | **Usage et facturation** | Décomposition des tokens par modèle (entrée / sortie / cache), coût en USD, graphiques en barres + camembert, filtres multidimensionnels | Sachez où passent vos tokens et votre argent — filtrez par utilisateur, modèle et période, facturez les équipes avec précision |
| <img src="static/deep-think-about.png" width="280" /> | **À propos** | Version, info de build, liens du projet, vérification des mises à jour en un clic | Restez à jour — consultez votre version de build et accédez directement aux docs, au repo et aux canaux de mise à jour |

## Démarrage rapide

### Prérequis

**Obligatoire** : [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (pour le mode conteneur ; admin en mode hôte n'en a pas besoin), et une clé API Claude (Anthropic officiel ou service de relais compatible).

**Optionnel** : identifiants d'application Feishu entreprise, Telegram Bot Token, identifiants QQ Bot, identifiants DingTalk, jeton WeChat iLink, Discord Bot Token, WhatsApp (scan QR au premier lancement) — uniquement si vous souhaitez des intégrations IM.

> Pas besoin d'installer Claude Code CLI manuellement — la dépendance Claude Agent SDK du projet inclut déjà le runtime complet de la CLI, installée automatiquement au premier `make start`.

### Installation et démarrage

```bash
# 1. Cloner le dépôt
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Démarrage en une commande (installe les dépendances et compile la première fois)
make start
```

Visitez http://localhost:9898 et suivez l'assistant de configuration : créez l'administrateur (aucun compte par défaut), configurez l'API Claude et, optionnellement, les canaux IM. Toute la configuration se fait depuis l'interface Web, sans fichiers de configuration. Les clés API sont stockées chiffrées en AES-256-GCM.

### Activer le mode conteneur

L'utilisateur admin utilise par défaut le mode hôte (pas de Docker). Si vous avez besoin du mode conteneur (les utilisateurs member l'utilisent automatiquement après inscription) :

```bash
./container/build.sh
```

Après inscription, chaque nouvel utilisateur obtient automatiquement un workspace principal en mode conteneur (`home-{userId}`), sans configuration supplémentaire.

## Vue d'ensemble de l'architecture


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink se compose de quatre projets Node.js indépendants :

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono) : service principal avec routeur de messages (polling 2s + déduplication), file de concurrence (jusqu'à 20 conteneurs + 5 processus hôte), planificateur de tâches (cron / interval / once), serveur WebSocket pour streaming temps réel et terminal, authentification bcrypt + HMAC Cookie, RBAC et gestion de configuration chiffrée AES-256-GCM. Persistance SQLite (mode WAL, schéma v1→v51). Il intègre également les couches Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox et Claude Code Plugins.
- **Frontend** (`web/`) : SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4, avec react-markdown, mermaid, recharts, xterm.js et PWA mobile.
- **Agent Runner** (`container/agent-runner/`) : moteur d'exécution qui tourne dans un conteneur Docker ou en processus hôte ; il invoque `query()` du Claude Agent SDK, émet plus de 30 types de StreamEvent via stdout et fournit 27 outils MCP au processus principal via des canaux IPC basés sur fichiers à écriture atomique.
- **Desktop** (`desktop/`) : un shell Electron qui package une application autonome pour macOS / Windows / Linux.

Les huit canaux IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entrent par le routeur, sont dédupliqués et routés vers la file, qui via le ProviderPool sélectionne la clé API / le moteur et démarre un conteneur, un processus hôte ou un sandbox. Les événements de streaming sont diffusés via WebSocket au client Web ou renvoyés via les APIs IM à chaque canal.

## Documentation complète

Pour le guide complet, consultez :

- [Version complète en anglais](README.md)
- [Version complète en 简体中文](README.zh-CN.md)

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
