// Registry data cache — the fix for "every tab pulls from the DB".
//
// Agents / skills / hooks / rules / patterns are near-static text: they only
// change when a framework sync (update_all / gateway loader) rewrites them.
// Serving them force-dynamic meant every navigation ran live Atlas queries
// from a Vercel function — 300ms+ per tap for content that hadn't changed.
//
// unstable_cache persists the SERIALIZED results in the Next data cache
// (across function invocations on Vercel) for REVALIDATE seconds, so the
// page function returns without touching Mongo on warm paths. Values must be
// JSON-serializable — every fetcher returns plain shapes (no ObjectId/Date).
import { unstable_cache } from 'next/cache';
import { connectDB, Agent, Skill, Hook, Rule, Pattern } from '@/lib/db';

const REVALIDATE = 60; // 1 min — a framework sync shows up fast; warm taps still never touch Atlas

export const getRegistryCounts = unstable_cache(
  async () => {
    try {
      await connectDB();
      const [agents, skills, hooks, rules, patterns] = await Promise.all([
        Agent.countDocuments(),
        Skill.countDocuments(),
        Hook.countDocuments(),
        Rule.countDocuments(),
        Pattern.countDocuments(),
      ]);
      return { agents, skills, hooks, rules, patterns };
    } catch {
      return { agents: 0, skills: 0, hooks: 0, rules: 0, patterns: 0 };
    }
  },
  ['registry-counts'],
  { revalidate: REVALIDATE }
);

export const getAgentsCached = unstable_cache(
  async () => {
    await connectDB();
    const agents = await Agent.find({}).select('-instructions -contentHash -__v').sort({ category: 1, name: 1 }).lean();
    return agents.map(a => ({
      _id: String(a._id),
      name: a.name as string,
      description: a.description as string,
      tools: (a.tools as string[]) ?? [],
      category: a.category as string,
      loadedAt: a.loadedAt ? new Date(a.loadedAt as Date).toISOString() : '',
    }));
  },
  ['registry-agents'],
  { revalidate: REVALIDATE }
);

export const getSkillsCached = unstable_cache(
  async () => {
    await connectDB();
    const skills = await Skill.find({}).select('-playbook -contentHash -__v').sort({ name: 1 }).lean();
    return skills.map(s => ({
      _id: String(s._id),
      name: s.name as string,
      description: s.description as string,
      triggers: (s.triggers as string[]) ?? [],
      loadedAt: s.loadedAt ? new Date(s.loadedAt as Date).toISOString() : '',
    }));
  },
  ['registry-skills'],
  { revalidate: REVALIDATE }
);

export const getHooksCached = unstable_cache(
  async () => {
    await connectDB();
    const hooks = await Hook.find({}).select('-__v').sort({ priority: 1 }).lean();
    return hooks.map(h => {
      const lastToggle = h.lastToggle as
        | { actorUserId?: string; role?: string; via?: string; previousState?: boolean; newState?: boolean; at?: Date }
        | undefined;
      return {
        _id: String(h._id),
        name: h.name as string,
        events: (h.events as string[]) ?? [],
        priority: h.priority as number,
        source: h.source as string,
        timeout: h.timeout as number,
        enabled: !!h.enabled,
        lastToggle: lastToggle
          ? {
              actorUserId: lastToggle.actorUserId,
              role: lastToggle.role,
              via: lastToggle.via,
              previousState: !!lastToggle.previousState,
              newState: !!lastToggle.newState,
              at: lastToggle.at ? new Date(lastToggle.at).toISOString() : '',
            }
          : undefined,
      };
    });
  },
  ['registry-hooks'],
  // Tagged so the /api/hooks toggle route can bust this cache immediately
  // (revalidateTag) instead of waiting out the 60s TTL.
  { revalidate: REVALIDATE, tags: ['registry-hooks'] }
);

export const getRulesCached = unstable_cache(
  async () => {
    await connectDB();
    const rules = await Rule.find({}).select('-__v -contentHash').sort({ category: 1, name: 1 }).lean();
    return rules.map(r => ({
      _id: String(r._id),
      name: r.name as string,
      description: r.description as string,
      category: r.category as string,
      content: r.content as string,
    }));
  },
  ['registry-rules'],
  { revalidate: REVALIDATE }
);

export const getPatternsCached = unstable_cache(
  async () => {
    await connectDB();
    const patterns = await Pattern.find({}).select('-__v').sort({ confidence: -1 }).lean();
    return patterns.map(p => ({
      _id: String(p._id),
      title: p.title as string,
      description: p.description as string,
      confidence: (p.confidence as number) || 0,
      tags: (p.tags as string[]) ?? [],
      usageCount: (p.usageCount as number) ?? 0,
      successCount: (p.successCount as number) ?? 0,
      failureCount: (p.failureCount as number) ?? 0,
      category: p.category as string,
    }));
  },
  ['registry-patterns'],
  { revalidate: REVALIDATE }
);
