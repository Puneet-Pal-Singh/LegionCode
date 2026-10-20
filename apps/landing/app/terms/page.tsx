import Link from "next/link";
import {
  LegalContact,
  LegalDocument,
  type LegalSection,
} from "@/components/legal/legal-document";
import { legalMetadata } from "@/lib/legal";
import { site } from "@/lib/site";

export const metadata = legalMetadata(
  "Terms of Service",
  "/terms/",
  "Terms for using LegionCode’s hosted website and cloud coding-agent workspace.",
);

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "Using the hosted service",
    content: (
      <>
        <p>
          These terms are between you and LegionCode (“we” or “us”) and cover
          the website, access-request form, and hosted coding-agent workspace at
          legioncode.dev. By using these hosted features, you agree to these
          terms. If you use LegionCode for an organization, you must have
          permission to act for that organization.
        </p>
        <p>
          You must be an adult who can enter into an agreement under the law
          where you live. The hosted service is intended for software
          development and is not offered to children.
        </p>
        <p>
          The source code is separately available under the{" "}
          <a href={`${site.githubUrl}/blob/main/LICENSE`}>MIT License</a> and
          any applicable component licenses. These hosted-service terms do not
          replace or restrict those licenses. If you operate your own
          deployment, you are responsible for that deployment and its users.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and connected access",
    content: (
      <>
        <p>
          Sign-in uses GitHub. Keep your GitHub account, provider accounts, API
          keys, and devices secure. Connect only repositories and services you
          are permitted to use, and supply accurate information when requesting
          access or support. Tell us promptly if someone uses your account
          without permission.
        </p>
        <p>
          Connecting a repository or provider authorizes LegionCode to use the
          access you grant for the tasks and features you request. Check the
          selected repository, branch, provider, and permission settings before
          starting a task. You can revoke access through the relevant provider;
          signing out alone does not revoke every connected credential.
        </p>
      </>
    ),
  },
  {
    id: "agent-actions",
    title: "Agent actions and human review",
    content: (
      <>
        <p>
          Coding agents can read files, propose and apply edits, run commands,
          access the network, and perform supported Git actions within the
          permissions you enable. Automated execution can change or delete data,
          install dependencies, or incur charges from connected services. Grant
          access appropriate to the task and keep independent backups.
        </p>
        <p>
          Generated explanations, code, commands, and review results can contain
          mistakes, security defects, or licensing issues. Inspect and test work
          before relying on it, merging it, or deploying it. Approval controls
          help you manage execution; they do not guarantee that every action or
          output is safe or correct.
        </p>
      </>
    ),
  },
  {
    id: "content",
    title: "Your code and workspace content",
    content: (
      <>
        <p>
          You keep the rights you have in the repositories, prompts, files, and
          other material you provide. LegionCode does not claim ownership of
          your private workspace content. You authorize the hosted service to
          receive, store, transmit, and process that content as needed to run
          your tasks, maintain their history, investigate failures, and protect
          the service.
        </p>
        <p>
          Make sure you have the necessary permissions before submitting another
          person’s code or personal information. Generated output can resemble
          other output or existing material. These terms do not grant rights
          that LegionCode does not own; applicable law, source licenses, and
          your model provider’s conditions still apply.
        </p>
        <p>
          Our <Link href="/privacy/">Privacy Policy</Link> explains the data
          involved in hosted execution, including stored credentials and chat
          history.
        </p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Providers, integrations, and costs",
    content: (
      <>
        <p>
          GitHub, model providers, hosting providers, and other integrations are
          separate services. Their terms, usage restrictions, account limits,
          and privacy practices apply to your use of them. You are responsible
          for the provider accounts and credentials you connect and for charges
          incurred through those accounts, including requests made during tasks
          that fail or are stopped.
        </p>
        <p>
          Bringing your own key does not include a model subscription or change
          your provider’s prices. If LegionCode offers a paid hosted feature,
          its price and payment conditions will be presented before purchase. We
          do not guarantee a third party’s uptime, supported models,
          compatibility, or continued availability.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Protecting people and infrastructure",
    content: (
      <>
        <p>
          Use the hosted service lawfully and respect other people’s
          intellectual property, privacy, and security. In particular, do not:
        </p>
        <ul>
          <li>
            Access repositories, accounts, or systems without authorization.
          </li>
          <li>
            Steal credentials or data, distribute harmful software, or conduct
            attacks outside security work you are authorized to perform.
          </li>
          <li>
            Evade access restrictions or quotas, escape workspace isolation, or
            disrupt the service or other users’ tasks.
          </li>
          <li>
            Use hosted execution for spam, fraudulent activity, cryptocurrency
            mining, or workloads unrelated to permitted development tasks.
          </li>
        </ul>
        <p>
          Report vulnerabilities privately through the repository’s{" "}
          <a href={`${site.githubUrl}/security/policy`}>
            security reporting process
          </a>
          . Never include secrets or private repository data in a public issue.
        </p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Preview features and availability",
    content: (
      <>
        <p>
          LegionCode is being developed actively. Alpha, preview, and
          experimental features may be incomplete, have limits, or lose data.
          Features and integrations may change, and maintenance or provider
          failures may interrupt access. Keep your repository and important work
          backed up outside the hosted service.
        </p>
        <p>
          We may limit or suspend access to investigate abuse, protect other
          users, respond to security incidents, or comply with the law. When
          circumstances permit, we will explain a material restriction and how
          to contact us about it. Urgent protective action may happen first.
        </p>
      </>
    ),
  },
  {
    id: "ending-use",
    title: "Stopping use and requesting deletion",
    content: (
      <>
        <p>
          You can stop using the hosted service, disconnect stored provider
          credentials, and revoke GitHub authorization at any time. To request
          account or hosted-data deletion, use the contact details in the
          Privacy Policy. We may verify your identity before acting on a
          request.
        </p>
        <p>
          Signing out, archiving a chat, or revoking GitHub access does not
          itself erase existing transcripts or workspace records. Deletion is
          subject to the retention needs and legal rights explained in the
          Privacy Policy. It does not remove copies held by your model providers
          or repositories you control.
        </p>
      </>
    ),
  },
  {
    id: "responsibility",
    title: "Warranties and responsibility",
    content: (
      <>
        <p>
          To the extent the law allows, the hosted service is supplied as
          available, without a promise that it will meet a particular purpose,
          operate without interruption, or produce accurate or non-infringing
          results. You remain responsible for decisions about using generated
          work and for securing the systems and services you connect.
        </p>
        <p>
          Where legally permitted, LegionCode is not responsible for indirect
          losses such as lost business opportunities or profits resulting from
          service interruptions or reliance on agent output. This paragraph does
          not exclude responsibility that cannot lawfully be excluded, and does
          not remove consumer protections or other mandatory rights you have.
        </p>
      </>
    ),
  },
  {
    id: "updates-contact",
    title: "Updates, questions, and contact",
    content: (
      <>
        <p>
          We will date revisions on this page and provide notice of material
          changes where the law requires it. Updated terms apply prospectively.
          If you do not accept a change, stop using the hosted service. Contact
          LegionCode about questions, complaints, or a dispute so we can try to
          resolve it. Applicable law and any mandatory rights to bring a claim
          remain available to you.
        </p>
        <LegalContact />
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      introduction="The conditions for using LegionCode’s hosted website and cloud coding-agent workspace."
      sections={sections}
    />
  );
}
