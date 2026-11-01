import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth';
import { ApiProblem, getMe } from '../api';
import { Button, Field, Input, ProblemBanner, Textarea } from '../components/ui';

function CopyLine({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-line">
      <code>{value}</code>
      <button
        type="button"
        className="icon-button icon-button--quiet"
        aria-label="Copy command"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export function ConnectPage({ mode = 'connect' }: { mode?: 'connect' | 'connection' }) {
  const { token, cubeToken, connect, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const expired = params.get('expired') === '1';
  const [apiToken, setApiToken] = useState(token ?? '');
  const [cubeTokenValue, setCubeTokenValue] = useState(cubeToken ?? '');
  const [error, setError] = useState<ApiProblem | Error | null>(null);
  const [busy, setBusy] = useState(false);

  if (mode === 'connect' && token && !expired) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await getMe(apiToken.trim());
      connect(apiToken, cubeTokenValue);
      navigate('/');
    } catch (submitError) {
      setError(submitError as ApiProblem | Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect">
      <section className="connect__story">
        <div className="brand brand--large">
          <span className="brand__mark">CPM</span>
          <span className="brand__slash">/</span>
          <span className="brand__lite">LITE</span>
        </div>
        <div className="connect__statement">
          <p className="connect__lede">A planning workspace that keeps every assumption, run and approval on one auditable line.</p>
          <div className="connect__rule" />
          <dl className="connect__facts">
            <div>
              <dt>Scope</dt>
              <dd>Department and cost-centre aware</dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd>Isolated, reproducible scenario jobs</dd>
            </div>
            <div>
              <dt>Promotion</dt>
              <dd>Steward review, then a versioned plan</dd>
            </div>
          </dl>
        </div>
        <p className="connect__fineprint">Synthetic demo workspace · CPM Lite phase 1</p>
      </section>

      <section className="connect__form">
        <div className="connect__form-inner">
          <div className="connect__heading">
            <KeyRound size={18} aria-hidden />
            <h1>{mode === 'connection' ? 'Connection' : 'Enter the workspace'}</h1>
          </div>
          <p className="connect__copy">
            {mode === 'connection'
              ? 'Update the tokens used by this tab. API tokens identify you to the orchestrator; the Cube token unlocks governed variance queries.'
              : 'Paste a development token minted for your department. Tokens stay in this tab’s session storage and are sent only to the local API.'}
          </p>

          {expired ? <ProblemBanner error={new Error('Your session token was rejected. Mint a fresh token below.')} /> : null}
          <ProblemBanner error={error} />

          <form onSubmit={handleSubmit} className="connect__fields">
            <Field label="API token" htmlFor="api-token" hint="Required. Mint it with the command below.">
              <Textarea
                id="api-token"
                rows={4}
                spellCheck={false}
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiIs…"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Cube token"
              htmlFor="cube-token"
              hint="Optional. Required for the Variance screen; leave blank to use the orchestrator only."
            >
              <Textarea
                id="cube-token"
                rows={3}
                spellCheck={false}
                value={cubeTokenValue}
                onChange={(event) => setCubeTokenValue(event.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiIs…"
                autoComplete="off"
              />
            </Field>

            <div className="connect__commands">
              <span>API token</span>
              <CopyLine value="npm --prefix apps/api run token -- --department finance" />
              <span>Cube token</span>
              <CopyLine value="npm --prefix cube run token -- --department finance" />
            </div>

            <div className="connect__actions">
              <Button type="submit" variant="primary" loading={busy} icon={ArrowRight}>
                {mode === 'connection' ? 'Update connection' : 'Open workspace'}
              </Button>
              {mode === 'connection' ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    signOut();
                    navigate('/connect');
                  }}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          </form>

          <p className="connect__security">
            <ShieldCheck size={14} aria-hidden />
            Local HS256 tokens are development-only. Production identity is Microsoft Entra ID.
          </p>
        </div>
      </section>
    </div>
  );
}
