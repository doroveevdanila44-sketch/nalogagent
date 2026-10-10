export function Skeletons() {
  return (
    <div aria-busy="true" aria-label="Загрузка">
      <div className="skeleton" style={{ height: 190, borderRadius: 22, marginTop: 18 }} />
      <div className="sec">
        <div className="skeleton" style={{ height: 24, width: 180 }} />
        <div className="skeleton" style={{ height: 64, marginTop: 14 }} />
        <div className="skeleton" style={{ height: 64, marginTop: 10 }} />
      </div>
      <div className="sec">
        <div className="skeleton" style={{ height: 24, width: 260 }} />
        <div className="skeleton" style={{ height: 220, marginTop: 14 }} />
      </div>
      <div className="sec">
        <div className="skeleton" style={{ height: 24, width: 100 }} />
        <div className="ents" style={{ marginTop: 14 }}>
          {[0, 1].map((i) => (
            <div key={i} className="skeleton" style={{ height: 300, borderRadius: 18 }} />
          ))}
        </div>
      </div>
    </div>
  );
}
