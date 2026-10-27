// SwarmVideos — short screen recordings of the real /swarm console, recorded
// with Playwright from the running app (scripts: e2e/record-swarm-videos.spec.ts)
// and served from /public/videos. Muted, looped, lazy (preload="none" until
// visible) so the page stays fast; each has a poster frame and a caption.
const VIDEOS = [
  { src: '/videos/swarm-live.webm', poster: '/videos/swarm-live.jpg', title: 'Live console', caption: 'Real swarms from Atlas: the pipeline lights up as each child moves paused → running → done, with progress and token budget.' },
  { src: '/videos/swarm-approve-stop.webm', poster: '/videos/swarm-approve-stop.jpg', title: 'Approve → Stop', caption: 'Approve a planned swarm, watch children become claimable, then hit Stop — open children pause and everyone involved gets mail.' },
  { src: '/videos/swarm-demo-lanes.webm', poster: '/videos/swarm-demo-lanes.jpg', title: 'How a swarm works', caption: 'The topology demo: one job decomposed across lanes, dispatched hierarchical / mesh / ring / star.' },
];

export function SwarmVideos() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {VIDEOS.map((v) => (
        <figure key={v.src} className="gel-surface overflow-hidden rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/70">
          <video
            className="aspect-video w-full bg-black object-cover"
            src={v.src}
            poster={v.poster}
            muted
            loop
            playsInline
            controls
            preload="none"
            aria-label={v.title}
          />
          <figcaption className="px-4 py-3">
            <p className="text-sm font-medium text-[rgb(var(--text-primary))]">{v.title}</p>
            <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">{v.caption}</p>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
