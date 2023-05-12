// components/Benefits/Benefits.tsx

import Image from 'next/image';
import styles from './Benefits.module.css';

// static images
import realtimeCollab from '@/public/benefits/realtimeCollab.svg';
import persistence from '@/public/benefits/persistence.svg';
import conflictResolution from '@/public/benefits/conflict-resolution.svg';
import offline from '@/public/benefits/offline.svg';
import tools from '@/public/benefits/tools.svg';

const Benefits = () => (
  <div className={styles.benefitsGrid}>
    {/* 120 FPS */}
    <div className={styles.benefitBlock}>
      <div className={styles.benefitIconContainer}>
        <Image
          src={realtimeCollab}
          loading="lazy"
          alt="120 FPS cursor"
          className={styles.benefitIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitTitle}>
          Absurdly Smooth Motion – Automatically
        </h3>
        <p className={styles.benefitDescription}>
          Reflect syncs changes at 120 FPS (hardware permitting), eliminating
          the need for difficult and complex interpolation code. Adaptive
          buffering provides buttery smooth, precision playback &#8212; across
          town or across the globe.
        </p>
      </div>
    </div>

    {/* Servers */}
    <div className={styles.benefitBlock}>
      <div className={styles.benefitIconContainer}>
        <Image
          src={conflictResolution}
          loading="lazy"
          alt="Servers: Pretty Great"
          className={styles.benefitIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitTitle}>Servers: Pretty Great</h3>
        <p className={styles.benefitDescription}>
          CRDTs are designed for a world without servers. Reflect instead
          embraces the server, enabling you to run your own server-side code for
          validation, business logic, fine-grained authorization, background
          processing, integration with other services, and more.
        </p>
      </div>
    </div>

    {/* Transactional Conflict Resolution */}
    <div className={styles.benefitBlock}>
      <div className={styles.benefitIconContainer}>
        <Image
          src={conflictResolution}
          loading="lazy"
          alt="Conflict resolution"
          className={styles.benefitIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitTitle}>Server Authority</h3>
        <p className={styles.benefitDescription}>
          CRDTs converge, but to what??
        </p>
        <p className={styles.benefitDescription}>
          Reflect uses a more flexible and intuitive technique based on{' '}
          <a href="https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html">
            Server Reconciliation
          </a>
          . <strong>Your mutation code</strong> runs server-side &#8212;
          enabling custom validation, business logic, and fine-grained
          authorization.
        </p>
      </div>
    </div>

    {/* Optional Offline */}
    <div className={styles.benefitBlock}>
      <div className={styles.benefitIconContainer}>
        <Image
          src={offline}
          loading="lazy"
          alt="Offline"
          className={styles.benefitIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitTitle}>Local-First</h3>
        <p className={styles.benefitDescription}>
          Set <code className="inline">clientPersistence: true</code>
          &nbsp; and data is also stored on the client, providing instant
          (“local-first”) startup, navigation, and offline support.
        </p>
      </div>
    </div>

    {/* On-Prem */}
    <div className={styles.benefitBlock}>
      <div className={styles.benefitIconContainer}>
        <Image
          src={tools}
          loading="lazy"
          alt="Tools"
          className={styles.benefitIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitTitle}>On-&ldquo;Prem&rdquo; Available</h3>
        <p className={styles.benefitDescription}>
          Use Reflect as a traditional SaaS, or deploy it to your own Cloudflare
          account.
        </p>
        <p className={styles.benefitDescription}>
          We&apos;ll run, monitor, and update it. You maintain control,
          ownership, and business continuity with a perpetual source license.
        </p>
      </div>
    </div>

    {/* 
    <div className={styles.benefitBlockFull}>
      <div className={styles.benefitFullIconContainer}>
        <Image
          src={productivity}
          loading="lazy"
          alt="Productivity"
          className={styles.benefitFullIcon}
        />
      </div>
      <div className={styles.benefitInfoContainer}>
        <h3 className={styles.benefitFullTitle}>Even More Coming Soon</h3>
        <p className={styles.benefitDescription}>
          First-class history, branching, painless migrations, and more!
        </p>
      </div>
    </div>
        */}
  </div>
);

export default Benefits;
