import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="not-found">
      <p className="mono">404</p>
      <h1>That page is not on the ledger.</h1>
      <p>The route does not exist or is outside this workspace.</p>
      <Link to="/" className="button button--primary button--md">Return to overview</Link>
    </div>
  );
}
