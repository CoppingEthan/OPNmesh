export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 text-2xl font-bold tracking-tight">
        <span className="text-brand">OPN</span>
        <span className="text-ink">mesh</span>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
