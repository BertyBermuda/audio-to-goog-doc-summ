// Vercel needs at least one page for the build to produce something.
// Deliberately says nothing about configuration — this URL is public.
export default function Home() {
  return (
    <main style={{ font: "14px/1.6 system-ui, sans-serif", padding: 40, maxWidth: 520 }}>
      <h1 style={{ fontSize: 18 }}>Audio to Google Doc Summarizer</h1>
      <p>Backend for the Chrome extension. Nothing to see here.</p>
    </main>
  );
}
