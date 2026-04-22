# Changelog

## [0.1.1](https://github.com/first-fluke/agent-valley/compare/agent-valley-v0.1.0...agent-valley-v0.1.1) (2026-04-22)


### Features

* **cli:** add --scope option to issue command for routing label attachment ([ba9491e](https://github.com/first-fluke/agent-valley/commit/ba9491ea7c4bb23749c2f7f6606c2838af787251))
* **cli:** add av logs and av top commands ([08c3330](https://github.com/first-fluke/agent-valley/commit/08c3330cc92f8d5419d9b1fa981f19bd9ac187e5))
* **cli:** add av up/down daemon lifecycle commands ([a116991](https://github.com/first-fluke/agent-valley/commit/a11699121780cb3d2a8dd81174275df9915e696c))
* **cli:** prepare npm distribution with dual bin commands ([face26a](https://github.com/first-fluke/agent-valley/commit/face26a00de44b90ed7166df466fd409fa7b952a))
* **dashboard:** add office pets, poop cleanup, L-shaped bathroom ([61db326](https://github.com/first-fluke/agent-valley/commit/61db3261d39e4fedb25bc3696b8dfecac02e54f8))


### Bug Fixes

* **ci:** resolve all typecheck errors, split tsc per workspace ([f342907](https://github.com/first-fluke/agent-valley/commit/f342907dd3f4514593c438b5de8dd20f5799e368))
* **core:** fix av up supervisor restart loop and standalone path resolution ([b1154b2](https://github.com/first-fluke/agent-valley/commit/b1154b26be4aae19dabcb53bd13f1f56f87dc60b))
* eliminate session output accumulation + add supervisor self-healing ([452b77f](https://github.com/first-fluke/agent-valley/commit/452b77f24065c4524e0154773bf94ba593b945fc))
* monorepo path resolution — cwd-based ROOT, remove @/ alias from core ([8253e30](https://github.com/first-fluke/agent-valley/commit/8253e302a8f35809450bf82f896bcd18b3383602))
* **orchestrator:** recover startup sync and routed worktrees ([3052f80](https://github.com/first-fluke/agent-valley/commit/3052f8039d8c50205a9fc0e9cb7eca4a481d43a7))
* prevent orchestrator errors from crashing dashboard + auto-restart ([e72b4f9](https://github.com/first-fluke/agent-valley/commit/e72b4f9c69abc0ea8b3a5517389f1f747cf15033))
* standalone static files — symlink .next/static + public into standalone dir ([1c32dae](https://github.com/first-fluke/agent-valley/commit/1c32dae64ce7eec1a76653e29b7eb04bd46601d0))


### Performance Improvements

* av up builds standalone + runs production server ([78220dc](https://github.com/first-fluke/agent-valley/commit/78220dc2205ad952c392bae9991f033154f5d645))
