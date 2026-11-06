import Link from "next/link";
import {
  LegalContact,
  LegalDocument,
  type LegalSection,
} from "@/components/legal/legal-document";
import { legalMetadata } from "@/lib/legal";

export const metadata = legalMetadata(
  "Privacy Policy",
  "/privacy/",
  "How LegionCode’s hosted website and cloud workspace handle account information, code, credentials, and task history.",
);

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "What this policy covers",
    content: (
      <>
        <p>
          This policy describes how LegionCode (“we” or “us”) handles
          information through the website, access-request form, and hosted cloud
          workspace at legioncode.dev. Contact information appears below.
          Information in a workspace can include personal information contained
          in your code, prompts, attachments, and tool results.
        </p>
        <p>
          If you run the open-source software yourself, you control that
          deployment’s storage, logging, and provider connections. This policy
          covers information sent to our hosted features; it does not describe
          every independent deployment or replace the policies of services you
          connect.
        </p>
      </>
    ),
  },
  {
    id: "information",
    title: "Information used by the hosted service",
    content: (
      <ul>
        <li>
          <strong>Access requests:</strong> your email address, the form’s
          source, and request timestamps when you join the cloud-access
          waitlist.
        </li>
        <li>
          <strong>GitHub identity and access:</strong> your account identifier,
          login, avatar, available name and email, commit identity,
          authorization scopes, and OAuth credentials needed for the connection.
        </li>
        <li>
          <strong>Workspace content:</strong> connected repository details,
          branches, checked-out files, prompts, attachments, responses, commands
          and their results, proposed changes, review artifacts, and Git
          actions.
        </li>
        <li>
          <strong>Task and connection records:</strong> thread and run history,
          permission decisions, provider selection, connection status, API
          credentials you supply, model usage, and related task metadata.
        </li>
        <li>
          <strong>Operations and support:</strong> request and error records,
          diagnostic identifiers, and information you send when asking for help.
          Hosting and network providers also receive network information such as
          IP addresses and browser request metadata when serving requests.
        </li>
      </ul>
    ),
  },
  {
    id: "cloud-processing",
    title: "How cloud tasks process your data",
    content: (
      <>
        <p>
          Cloud tasks execute on hosted infrastructure. The runtime can read the
          connected repository, use the credentials required for the task, and
          send prompts, selected context, attachments, and tool results to the
          model provider you configure. Supported integrations may receive
          information when your instructions or enabled tools call them.
        </p>
        <p>
          Transcripts, lifecycle events, workspace metadata, and review
          artifacts are stored server-side so tasks can continue and their
          history can be reconstructed. We use account and operational
          information to control access, run the service, troubleshoot failures,
          prevent abuse, answer requests, and meet applicable legal obligations.
        </p>
        <p>
          Provider credentials are stored in encrypted form. The service
          decrypts them when needed to validate a connection or make authorized
          provider requests. Using your own API key still involves server-side
          processing for hosted tasks. See the{" "}
          <a href="/docs/credentials/">provider credential documentation</a> for
          more detail.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Services and people that receive information",
    content: (
      <>
        <p>
          Information is shared as necessary to operate the features you use:
        </p>
        <ul>
          <li>
            GitHub handles sign-in and repository operations. Your chosen model
            providers process the inputs and requests sent to them under your
            provider account and its data controls.
          </li>
          <li>
            Hosting, networking, execution, database, and storage services
            process information for the hosted product. LegionCode uses
            Cloudflare infrastructure and server-side product databases and
            object storage.
          </li>
          <li>
            Authorized LegionCode maintainers may access information needed to
            investigate a support request, resolve a fault, protect the service,
            or respond to a verified data request.
          </li>
          <li>
            Information may be disclosed when legally required, to investigate
            abuse or protect people and systems, or when you direct a feature to
            share it, such as publishing a commit or pull request.
          </li>
        </ul>
        <p>
          We do not sell personal information or use private workspace content
          for targeted advertising. The information you publish to GitHub or
          another service is subject to the visibility you choose there.
        </p>
      </>
    ),
  },
  {
    id: "ai-providers",
    title: "Model providers and training",
    content: (
      <>
        <p>
          LegionCode uses configured model providers to perform the tasks you
          request. LegionCode does not use your private code, prompts, or task
          responses to train its own models. Keeping task history to support
          replay and review is separate from training a model.
        </p>
        <p>
          A provider’s own retention, security, and training terms apply to
          information sent to that provider. Those terms can differ by provider,
          account type, and settings. Review them before using confidential or
          personal information. Connecting a provider through LegionCode does
          not change your agreement with that provider.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and data on your device",
    content: (
      <>
        <p>
          The hosted app uses an essential session cookie to keep you signed in.
          Browser local storage and session storage are also used for
          preferences, selected context, caches, and diagnostic identifiers.
          Server-side records remain the source for account and task history.
        </p>
        <p>
          You can clear cookies and site storage in your browser. Doing so can
          sign you out or reset preferences; it does not delete the hosted
          records or information held by a connected provider.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "Retention and deletion requests",
    content: (
      <>
        <p>
          We keep records needed to operate accounts and workspaces, preserve
          requested task history, investigate faults and abuse, and meet legal
          obligations. The period depends on the record and its purpose. Some
          temporary execution data and artifacts may expire separately from
          account and transcript records.
        </p>
        <p>
          You may ask for account or hosted-data deletion using the contact
          below. We may need to verify your identity and authority over a
          workspace. Records required by law or needed for an active security
          investigation may be retained, and backups may persist until their
          normal removal. We will explain any applicable limits when handling
          your request.
        </p>
        <p>
          Signing out, archiving a chat, clearing your browser, or revoking
          GitHub authorization is not a deletion request. Disconnecting a
          provider removes it from active LegionCode connections; historical
          credential records can remain subject to the retention needs above.
          Revoke the credential with the provider as well if you want it to stop
          working elsewhere. We cannot erase copies held independently by your
          repository host, model provider, or your own deployments.
        </p>
      </>
    ),
  },
  {
    id: "choices",
    title: "Your choices and applicable rights",
    content: (
      <>
        <p>
          You choose which repositories and providers to connect, what to submit
          in a task, and which supported actions to authorize. You can stop
          using hosted features, disconnect provider connections, and revoke
          GitHub access from your GitHub account settings. Keep passwords, API
          keys, and unnecessary personal information out of prompts and support
          reports.
        </p>
        <p>
          Depending on the law that applies to you, you may have rights to
          access, correct, obtain a copy of, or request deletion of personal
          information, and to object to or limit certain processing. Contact us
          to make a request. We will assess it under applicable law, verify
          identity where needed, and explain the outcome. You may also have the
          right to contact a privacy regulator or appeal a decision.
        </p>
      </>
    ),
  },
  {
    id: "security-location",
    title: "Security and processing locations",
    content: (
      <>
        <p>
          Hosted access uses HTTPS, session cookies have security protections,
          and connected credentials are encrypted when stored. Access controls,
          workspace boundaries, and diagnostic redaction help protect the
          service. No system can eliminate every risk. Limit connected
          permissions, review changes, and protect your own accounts and
          backups.
        </p>
        <p>
          Processing locations depend on the hosting infrastructure and
          providers used for a feature and may be outside your country. This
          notice does not promise that all workspace data stays in a particular
          country or region. Contact us before submitting data that requires a
          specific processing arrangement.
        </p>
      </>
    ),
  },
  {
    id: "updates-contact",
    title: "Children, updates, and contact",
    content: (
      <>
        <p>
          The hosted service is intended for adults and is not directed to
          children. If you believe a child supplied personal information,
          contact us so that we can investigate and take appropriate action.
        </p>
        <p>
          Revisions will be dated on this page. We will give additional notice
          of material changes where required. Questions about this policy and
          requests concerning your personal information can be sent to the
          contact route below. See also our{" "}
          <Link href="/terms/">Terms of Service</Link>.
        </p>
        <LegalContact />
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      introduction="How the hosted LegionCode service handles your account, repository content, provider credentials, and task history."
      sections={sections}
    />
  );
}
