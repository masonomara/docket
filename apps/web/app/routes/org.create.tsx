import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import type { Route } from "./+types/org.create";
import { API_URL } from "~/lib/auth-client";
import { apiFetch } from "~/lib/api";
import {
  ORGANIZATION_TYPES,
  FIRM_SIZES,
  US_STATES,
  PRACTICE_AREAS,
} from "~/lib/org-constants";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import styles from "~/styles/org-create.module.css";

// Step configuration
const STEPS = [
  {
    title: "Organization Type",
    subtitle: "What type of organization are you creating?",
  },
  {
    title: "Basic Information",
    subtitle: "Tell us about your firm",
  },
  {
    title: "Jurisdictions",
    subtitle: "Select the states where you practice",
  },
  {
    title: "Practice Areas",
    subtitle: "Select your areas of practice",
  },
];

type StepNumber = 1 | 2 | 3 | 4;

interface FormData {
  orgType: string;
  name: string;
  firmSize: string;
  jurisdictions: string[];
  practiceAreas: string[];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Check if user is logged in
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );

  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect("/auth");
  }

  // Check if user already has an organization
  const orgResponse = await apiFetch(context, "/api/user/org", cookie);

  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      // User already has an org, redirect to dashboard
      throw redirect("/dashboard");
    }
  }

  return { user: sessionData.user };
}

export default function OrgCreatePage(_props: Route.ComponentProps) {
  const navigate = useNavigate();

  // Wizard state
  const [step, setStep] = useState<StepNumber>(1);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form data
  const [form, setForm] = useState<FormData>({
    orgType: "",
    name: "",
    firmSize: "",
    jurisdictions: [],
    practiceAreas: [],
  });

  /**
   * Update a single field in the form
   */
  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Toggle an item in an array field (jurisdictions or practiceAreas)
   */
  function toggleArrayField(
    field: "jurisdictions" | "practiceAreas",
    id: string
  ) {
    setForm((prev) => {
      const currentArray = prev[field];
      const isSelected = currentArray.includes(id);

      const newArray = isSelected
        ? currentArray.filter((item) => item !== id)
        : [...currentArray, id];

      return { ...prev, [field]: newArray };
    });
  }

  /**
   * Check if the current step has valid data to proceed
   */
  function canProceedToNextStep(): boolean {
    switch (step) {
      case 1:
        return form.orgType !== "";
      case 2:
        return form.name.trim() !== "" && form.firmSize !== "";
      case 3:
        return form.jurisdictions.length > 0;
      case 4:
        return form.practiceAreas.length > 0;
      default:
        return false;
    }
  }

  function goToPreviousStep() {
    if (step > 1) {
      setStep((prev) => (prev - 1) as StepNumber);
    }
  }

  function goToNextStep() {
    if (step < 4 && canProceedToNextStep()) {
      setStep((prev) => (prev + 1) as StepNumber);
    }
  }

  async function handleSubmit() {
    if (!canProceedToNextStep()) {
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}/api/org`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: form.name.trim(),
          firmSize: form.firmSize,
          jurisdictions: form.jurisdictions,
          practiceTypes: form.practiceAreas,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to create organization");
      }

      navigate("/dashboard");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  // Get current step configuration
  const currentStepConfig = STEPS[step - 1];

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        {/* Progress Indicator */}
        <div className={styles.progress}>
          {[1, 2, 3, 4].map((stepNumber) => {
            const isActive = stepNumber === step;
            const isCompleted = stepNumber < step;

            let stepClass = styles.progressStep;
            if (isActive) {
              stepClass = `${styles.progressStep} ${styles.active}`;
            } else if (isCompleted) {
              stepClass = `${styles.progressStep} ${styles.completed}`;
            }

            return <div key={stepNumber} className={stepClass} />;
          })}
        </div>

        <h1 className={styles.title}>{currentStepConfig.title}</h1>
        <p className={styles.subtitle}>{currentStepConfig.subtitle}</p>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Step 1: Organization Type */}
        {step === 1 && (
          <div className={styles.optionGrid}>
            {ORGANIZATION_TYPES.map((type) => {
              const isSelected = form.orgType === type.id;
              const cardClass = isSelected
                ? `${styles.optionCard} ${styles.selected}`
                : styles.optionCard;

              return (
                <button
                  key={type.id}
                  type="button"
                  className={cardClass}
                  onClick={() => updateField("orgType", type.id)}
                >
                  {type.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Step 2: Basic Information */}
        {step === 2 && (
          <div className={styles.formFields}>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="orgName">
                Organization Name
              </label>
              <input
                id="orgName"
                type="text"
                className={styles.input}
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Smith & Associates"
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label}>Firm Size</label>
              <div className={styles.sizeGrid}>
                {FIRM_SIZES.map((size) => {
                  const isSelected = form.firmSize === size.id;
                  const cardClass = isSelected
                    ? `${styles.sizeCard} ${styles.selected}`
                    : styles.sizeCard;

                  return (
                    <button
                      key={size.id}
                      type="button"
                      className={cardClass}
                      onClick={() => updateField("firmSize", size.id)}
                    >
                      <span className={styles.sizeLabel}>{size.label}</span>
                      <span className={styles.sizeDescription}>
                        {size.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Jurisdictions */}
        {step === 3 && (
          <div className={styles.checkboxGrid}>
            {US_STATES.map((state) => {
              const isSelected = form.jurisdictions.includes(state);
              const itemClass = isSelected
                ? `${styles.checkboxItem} ${styles.selected}`
                : styles.checkboxItem;

              return (
                <label key={state} className={itemClass}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleArrayField("jurisdictions", state)}
                    className={styles.checkboxInput}
                  />
                  <span className={styles.checkboxLabel}>{state}</span>
                </label>
              );
            })}
          </div>
        )}

        {/* Step 4: Practice Areas */}
        {step === 4 && (
          <div className={styles.practiceGrid}>
            {PRACTICE_AREAS.map((area) => {
              const isSelected = form.practiceAreas.includes(area.id);
              const itemClass = isSelected
                ? `${styles.practiceItem} ${styles.selected}`
                : styles.practiceItem;

              return (
                <label key={area.id} className={itemClass}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleArrayField("practiceAreas", area.id)}
                    className={styles.checkboxInput}
                  />
                  <span className={styles.practiceLabel}>{area.label}</span>
                </label>
              );
            })}
          </div>
        )}

        {/* Navigation Buttons */}
        <div className={styles.buttons}>
          {step > 1 && (
            <button
              type="button"
              className="btn btn-secondary btn-lg"
              style={{ flex: 1 }}
              onClick={goToPreviousStep}
            >
              Back
            </button>
          )}

          {step < 4 ? (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              style={{ flex: 2 }}
              onClick={goToNextStep}
              disabled={!canProceedToNextStep()}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              style={{ flex: 2 }}
              onClick={handleSubmit}
              disabled={!canProceedToNextStep() || isSubmitting}
            >
              {isSubmitting ? "Creating..." : "Create Organization"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
