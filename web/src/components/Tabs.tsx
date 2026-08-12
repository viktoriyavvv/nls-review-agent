interface Props {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: Props) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={t.id === active ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
