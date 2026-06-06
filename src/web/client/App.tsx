import { useState } from "react";

/** Root component for the nanomind web app. */
export function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="card">
      <h1>nanomind</h1>
      <p className="subtitle">A simple React app served by Bun's built-in HTTP server.</p>

      <div className="counter">
        <button onClick={() => setCount((c) => c - 1)} aria-label="decrement">
          −
        </button>
        <span className="count">{count}</span>
        <button onClick={() => setCount((c) => c + 1)} aria-label="increment">
          +
        </button>
      </div>

      <p className="hint">
        Edit <code>src/web/client/App.tsx</code> and refresh to see your changes.
      </p>
    </div>
  );
}
