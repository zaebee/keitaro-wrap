import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { CampaignIntent } from "../../api/operations";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { resolveAttempt, storeAttempt } from "./operationStorage";
import styles from "./CreateCampaignPage.module.css";

type FieldErrors = Partial<Record<keyof CampaignIntent, string>>;

function validate(intent: CampaignIntent): FieldErrors {
  const errors: FieldErrors = {};
  if (!intent.name.trim()) {
    errors.name = "Enter a campaign name.";
  }
  if (!/^[A-Za-z]{2}$/.test(intent.country_code.trim())) {
    errors.country_code = "Use a two-letter ISO country code.";
  }
  if (!Number.isInteger(intent.offer_id) || intent.offer_id <= 0) {
    errors.offer_id = "Enter a positive integer offer ID.";
  }
  return errors;
}

export function CreateCampaignPage() {
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const [name, setName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [offerId, setOfferId] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    const attempt = resolveAttempt();
    if (attempt.operationUuid) {
      navigate(`/campaign-creations/${attempt.operationUuid}`, { replace: true });
    }
  }, [navigate]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const intent: CampaignIntent = {
      name: name.trim(),
      country_code: countryCode.trim().toUpperCase(),
      offer_id: Number(offerId),
    };
    const nextErrors = validate(intent);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const existing = resolveAttempt();
    if (existing.operationUuid) {
      navigate(`/campaign-creations/${existing.operationUuid}`, { replace: true });
      return;
    }

    const operationUuid = crypto.randomUUID();
    storeAttempt(operationUuid, intent);
    navigate(`/campaign-creations/${operationUuid}`, {
      state: { autoCreate: true, operation_uuid: operationUuid, intent },
    });
  };

  const errorList = Object.entries(errors);

  return (
    <section
      aria-labelledby="create-heading"
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
    >
      <h1 id="create-heading">Create campaign</h1>
      <p className={styles.lead}>
        Create a campaign with one primary offer.
      </p>

      {errorList.length > 0 && (
        <div className={styles.errorSummary} role="alert">
          <p>Check the following:</p>
          <ul>
            {errorList.map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor="campaign-name">Campaign name</label>
          <input
            id="campaign-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "campaign-name-error" : undefined}
          />
          {errors.name && (
            <p className={styles.fieldError} id="campaign-name-error">
              {errors.name}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor="country-code">Country code</label>
          <input
            id="country-code"
            name="country_code"
            value={countryCode}
            onChange={(event) => setCountryCode(event.target.value)}
            placeholder="US"
            maxLength={2}
            aria-invalid={Boolean(errors.country_code)}
            aria-describedby={
              errors.country_code ? "country-code-error" : undefined
            }
          />
          {errors.country_code && (
            <p className={styles.fieldError} id="country-code-error">
              {errors.country_code}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor="offer-id">Offer ID</label>
          <input
            id="offer-id"
            name="offer_id"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={offerId}
            onChange={(event) => setOfferId(event.target.value)}
            aria-invalid={Boolean(errors.offer_id)}
            aria-describedby={errors.offer_id ? "offer-id-error" : undefined}
          />
          {errors.offer_id && (
            <p className={styles.fieldError} id="offer-id-error">
              {errors.offer_id}
            </p>
          )}
        </div>

        <button className={styles.primary} type="submit">
          Create campaign
        </button>
      </form>
    </section>
  );
}
