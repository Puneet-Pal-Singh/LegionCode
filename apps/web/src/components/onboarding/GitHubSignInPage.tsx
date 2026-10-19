import { SiGithub } from "react-icons/si";
import "./GitHubSignInPage.css";

interface GitHubSignInPageProps {
  onLogin: () => void;
}

export function GitHubSignInPage({ onLogin }: GitHubSignInPageProps) {
  return (
    <main className="sign-in">
      <div className="sign-in__layout">
        <div className="sign-in__entry">
          <div className="sign-in__wordmark" role="img" aria-label="LegionCode">
            <span aria-hidden="true">
              Legion<span className="sign-in__wordmark-muted">Code</span>
            </span>
          </div>

          <section className="sign-in__content" aria-labelledby="sign-in-title">
            <h1 id="sign-in-title" className="sign-in__title">
              Sign in to LegionCode
            </h1>

            <button
              type="button"
              onClick={() => onLogin()}
              className="sign-in__github"
            >
              <SiGithub size={20} aria-hidden="true" />
              Continue with GitHub
            </button>
            <p className="sign-in__help">
              Use your GitHub account to continue.
            </p>
            <p className="sign-in__consent">
              By continuing, you agree to our
              <br />
              <span className="sign-in__policy">Terms of Service</span> and{" "}
              <span className="sign-in__policy">Privacy Policy</span>
            </p>
          </section>
        </div>

        <aside className="sign-in__visual" aria-label="Build with LegionCode">
          <div className="sign-in__artwork" aria-hidden="true" />
          <p className="sign-in__tagline">
            Brainstorm in Chat. <br />
            Build in Cloud.
          </p>
        </aside>
      </div>
    </main>
  );
}
