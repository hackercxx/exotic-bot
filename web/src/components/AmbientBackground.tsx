/** Ambient background: three blurred gradient orbs on 24s loops + faint grid (§5). */
export function AmbientBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="ambient-orb animate-orb"
        style={{
          width: 520,
          height: 520,
          top: -140,
          left: -120,
          background: 'radial-gradient(circle, rgba(229,25,45,0.5), transparent 65%)',
        }}
      />
      <div
        className="ambient-orb animate-orb"
        style={{
          width: 460,
          height: 460,
          top: '35%',
          right: -160,
          background: 'radial-gradient(circle, rgba(122,11,20,0.55), transparent 65%)',
          animationDelay: '-8s',
        }}
      />
      <div
        className="ambient-orb animate-orb"
        style={{
          width: 380,
          height: 380,
          bottom: -120,
          left: '30%',
          background: 'radial-gradient(circle, rgba(255,77,90,0.32), transparent 65%)',
          animationDelay: '-16s',
        }}
      />
      <div className="ambient-grid" />
    </div>
  );
}
