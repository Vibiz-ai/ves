## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Kind of change

- [ ] Bug fix
- [ ] New grader, connector or pack
- [ ] Change to what the gate accepts (needs a row in `protocol/LOG.md`)
- [ ] Docs or examples only

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `cd ui && npm test` passes (if `ui/` changed)
- [ ] Tests added or updated; no test touches the network
- [ ] If a rule, bar, grader behaviour or case meaning changed: `protocol/LOG.md` row added and versions bumped
- [ ] No run outputs, `.env` files, keys or real customer data committed
- [ ] CHANGELOG.md updated under "Unreleased"
