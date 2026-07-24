import { getHooksCached } from '@/lib/registry-cache';

export default async function HooksPage() {
  const hooks = await getHooksCached();

  return (
    <div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="card-table w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Events</th>
              <th className="px-4 py-3 text-center">Priority</th>
              <th className="px-4 py-3 text-center">Source</th>
              <th className="px-4 py-3 text-center">Timeout</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {hooks.map(h => (
              <tr key={h._id} className="hover:bg-zinc-800/30 active:bg-zinc-800/60 transition-colors">
                <td className="m-title px-4 py-2.5 font-mono text-xs text-zinc-300">{h.name}</td>
                <td data-label="Events" className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1 justify-end md:justify-start">
                    {h.events.map(e => (
                      <span key={e} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-emerald-400">{e}</span>
                    ))}
                  </div>
                </td>
                <td data-label="Priority" className="px-4 py-2.5 text-center text-xs text-zinc-400">{h.priority}</td>
                <td data-label="Source" className="px-4 py-2.5 text-center">
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    h.source === 'builtin' ? 'bg-blue-500/10 text-blue-400' :
                    h.source === 'bash' ? 'bg-orange-500/10 text-orange-400' :
                    'bg-zinc-800 text-zinc-400'
                  }`}>{h.source}</span>
                </td>
                <td data-label="Timeout" className="m-hide px-4 py-2.5 text-center text-xs text-zinc-500">{h.timeout}ms</td>
                <td data-label="Status" className="px-4 py-2.5 text-center">
                  <span className={`w-2 h-2 rounded-full inline-block ${h.enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
