# Changelog

## Unreleased

- Rules split by role (`core`, `workflow`, `controller`, `grunt-use`, `replies`); `config.mjs --print --role`.
- Grunt rotation at 60k (`grunt.rotateK`), new `grunt.coldCtxK` 40. The two must satisfy `coldCtxK < rotateK`:
  a user config that sets only `grunt.coldCtxK` to 60 or more fails that check, and both keys fall back to defaults.

## 0.1.0

First release.

- Three agents: `nestor:nestor`, `nestor:worker` and `nestor:grunt`, each with a 1-hour prompt cache.
- Four user-only skills: `/nestor:setup`, `/nestor:config`, `/nestor:run` and `/nestor:teardown`.
- A usage gate that reads ctx-meter's statusline snapshots and answers `GO`, `NO-START`, `STOP` or `NO-DATA`.
- A spawn guard hook that denies tagged spawns unless the gate says `GO`, and fails open on its own errors.
- One user config file with presets (Standard, No 5h limit (Ultra), Custom) and a config script.
- A switch for the whole gate and a switch for the 5-hour part only.
- Core and workflow rules for levels, pathways, waiting, context caps and briefs.
- A context check that finds ctx-meter's `ctx-check` in the plugin cache.
- An optional grunt log summary, `grunt-eval.mjs`.
- Documentation: how it works, writing briefs, add-ons.
