---
name: tech-evaluation
description: "Evaluate technology choices using structured criteria and comparison matrices. Recommend with rationale and document as ADR. Triggers: tech evaluation, should we use, compare technologies, tech choice, framework comparison, which library"
---

# Tech Evaluation Playbook

## 1. Define the Problem

- Clarify what capability is needed (e.g., state management, hosting, ORM).
- Read `documentation/AI_RULES.md` for existing tech mandates that constrain the choice.
- Identify must-have vs nice-to-have requirements.

## 2. Define Evaluation Criteria

- **Performance**: Benchmarks, latency, throughput.
- **Developer Experience**: API quality, documentation, learning curve.
- **Community & Ecosystem**: GitHub stars, npm downloads, plugin ecosystem.
- **Cost**: Licensing, hosting, operational overhead.
- **Scalability**: Horizontal/vertical scaling, concurrency model.
- **Maturity**: Version stability, breaking change history, LTS support.

## 3. List Candidates

- Identify 2-4 realistic candidates (avoid analysis paralysis).
- Include the "do nothing" or "build in-house" option if relevant.

## 4. Create Comparison Matrix

- Build a markdown table: rows = criteria, columns = candidates.
- Score each cell (1-5) with a brief justification.
- Weight criteria by importance to the project.

## 5. Proof of Concept (if needed)

- Build a minimal spike for the top 1-2 candidates.
- Time-box to 1-2 hours maximum.
- Test against the highest-weighted criteria.

## 6. Recommend

- State the recommendation clearly with rationale.
- Acknowledge trade-offs and risks of the chosen option.
- Note migration path if replacing an existing tool.

## 7. Document as ADR

- Create an ADR in `AI/architecture/` with:
  - Context, candidates considered, decision, consequences.
- Update `state/STATE.md` with the decision.
- Log the evaluation in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] All criteria defined before scoring.
- [ ] At least 2 candidates compared.
- [ ] Recommendation includes trade-offs.
- [ ] ADR recorded and linked.
