import { useState, useEffect } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { useAppContext } from "~/lib/use-app-context";
import { PageLayout } from "~/components/PageLayout";
import {
  ORGANIZATION_TYPES,
  FIRM_SIZES,
  US_STATES,
  PRACTICE_AREAS,
} from "~/lib/org-constants";
import { Plus } from "lucide-react";

interface FormData {
  orgType: string;
  name: string;
  firmSize: string;
  jurisdictions: string[];
  practiceAreas: string[];
}

const INITIAL_FORM_DATA: FormData = {
  orgType: "",
  name: "",
  firmSize: "",
  jurisdictions: [],
  practiceAreas: [],
};

const WIZARD_STEPS = [
  { title: "Firm Type", subtitle: "What type of firm are you creating?" },
  { title: "Basic Information", subtitle: "Tell us about your firm" },
  { title: "Jurisdictions", subtitle: "Select the states where you practice" },
  { title: "Practice Areas", subtitle: "Select your areas of practice" },
];

export default function Admin() {
  const { org } = useAppContext();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [showModal, setShowModal] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<FormData>(INITIAL_FORM_DATA);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Redirect to chat if user has an org
  useEffect(() => {
    if (org !== null) {
      navigate("/chat");
    }
  }, [org, navigate]);

  function openModal() {
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setCurrentStep(1);
    setFormData(INITIAL_FORM_DATA);
    setError(null);
    setIsSubmitting(false);
  }

  function goToNextStep() {
    setCurrentStep((prev) => prev + 1);
  }

  function goToPreviousStep() {
    setCurrentStep((prev) => prev - 1);
  }

  function updateFormField<K extends keyof FormData>(
    field: K,
    value: FormData[K]
  ) {
    setFormData((prev) => ({ ...prev, [field]: value }));
  }

  function toggleArrayField(
    field: "jurisdictions" | "practiceAreas",
    id: string
  ) {
    setFormData((prev) => {
      const currentArray = prev[field];
      const newArray = currentArray.includes(id)
        ? currentArray.filter((item) => item !== id)
        : [...currentArray, id];
      return { ...prev, [field]: newArray };
    });
  }

  function canProceedToNextStep(): boolean {
    switch (currentStep) {
      case 1:
        return formData.orgType !== "";
      case 2:
        return formData.name.trim() !== "" && formData.firmSize !== "";
      case 3:
        return formData.jurisdictions.length > 0;
      case 4:
        return formData.practiceAreas.length > 0;
      default:
        return false;
    }
  }

  async function handleSubmit() {
    if (!canProceedToNextStep()) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: formData.name.trim(),
          firmSize: formData.firmSize,
          jurisdictions: formData.jurisdictions,
          practiceTypes: formData.practiceAreas,
          orgType: formData.orgType,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to create firm");
      }

      closeModal();
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLastStep = currentStep === 4;

  // Don't render content if redirecting
  if (org !== null) {
    return null;
  }

  return (
    <>
      <PageLayout title="Get Started">
        <section className="section">
          <h2 className="text-title-3">Legal Organziation</h2>

          <div className="info-card">
            <div className="info-card-content">
              <h3 className="text-subhead">Create an organization</h3>
              <p className="text-secondary">
                Set up your legal organziation to start using Docket.
              </p>
            </div>
            <button onClick={openModal} className="btn btn-sm btn-primary">
              <Plus strokeWidth={2.25} size={13} style={{ margin: "3px", marginLeft: "0px" }} />
              Create organization
            </button>
          </div>
        </section>
      </PageLayout>

      {showModal && (
        <CreateFirmModal
          currentStep={currentStep}
          formData={formData}
          error={error}
          isSubmitting={isSubmitting}
          canProceed={canProceedToNextStep()}
          isLastStep={isLastStep}
          onClose={closeModal}
          onNext={goToNextStep}
          onBack={goToPreviousStep}
          onSubmit={handleSubmit}
          onUpdateField={updateFormField}
          onToggleArrayField={toggleArrayField}
        />
      )}
    </>
  );
}

// ============================================================================
// Create Firm Modal
// ============================================================================

interface CreateFirmModalProps {
  currentStep: number;
  formData: FormData;
  error: string | null;
  isSubmitting: boolean;
  canProceed: boolean;
  isLastStep: boolean;
  onClose: () => void;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
  onUpdateField: <K extends keyof FormData>(
    field: K,
    value: FormData[K]
  ) => void;
  onToggleArrayField: (
    field: "jurisdictions" | "practiceAreas",
    id: string
  ) => void;
}

function CreateFirmModal({
  currentStep,
  formData,
  error,
  isSubmitting,
  canProceed,
  isLastStep,
  onClose,
  onNext,
  onBack,
  onSubmit,
  onUpdateField,
  onToggleArrayField,
}: CreateFirmModalProps) {
  const stepInfo = WIZARD_STEPS[currentStep - 1];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <ModalHeader currentStep={currentStep} />

        <div className="modal-body">
          <h2 className="text-title-3">{stepInfo.title}</h2>
          <p className="text-secondary text-callout">{stepInfo.subtitle}</p>

          {error && <div className="alert alert-error">{error}</div>}

          {currentStep === 1 && (
            <FirmTypeStep
              selectedType={formData.orgType}
              onSelect={(type) => onUpdateField("orgType", type)}
            />
          )}

          {currentStep === 2 && (
            <BasicInfoStep
              name={formData.name}
              firmSize={formData.firmSize}
              onNameChange={(name) => onUpdateField("name", name)}
              onFirmSizeChange={(size) => onUpdateField("firmSize", size)}
            />
          )}

          {currentStep === 3 && (
            <JurisdictionsStep
              selectedJurisdictions={formData.jurisdictions}
              onToggle={(state) => onToggleArrayField("jurisdictions", state)}
            />
          )}

          {currentStep === 4 && (
            <PracticeAreasStep
              selectedPracticeAreas={formData.practiceAreas}
              onToggle={(areaId) => onToggleArrayField("practiceAreas", areaId)}
            />
          )}
        </div>

        <ModalFooter
          currentStep={currentStep}
          isLastStep={isLastStep}
          canProceed={canProceed}
          isSubmitting={isSubmitting}
          onBack={onBack}
          onNext={onNext}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Modal Header with Progress
// ============================================================================

interface ModalHeaderProps {
  currentStep: number;
}

function ModalHeader({ currentStep }: ModalHeaderProps) {
  return (
    <div className="modal-header">
      <div className="modal-progress">
        {[1, 2, 3, 4].map((stepNumber) => {
          let stepClass = "modal-progress-step";
          if (stepNumber === currentStep) {
            stepClass += " active";
          } else if (stepNumber < currentStep) {
            stepClass += " completed";
          }

          return (
            <div key={stepNumber} className="modal-progress-item">
              <div className={stepClass} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Modal Footer
// ============================================================================

interface ModalFooterProps {
  currentStep: number;
  isLastStep: boolean;
  canProceed: boolean;
  isSubmitting: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}

function ModalFooter({
  currentStep,
  isLastStep,
  canProceed,
  isSubmitting,
  onBack,
  onNext,
  onSubmit,
}: ModalFooterProps) {
  return (
    <div className="modal-actions">
      {currentStep > 1 && (
        <button
          type="button"
          className="btn btn-secondary btn-lg btn-lg-fit"
          onClick={onBack}
        >
          Back
        </button>
      )}

      {isLastStep ? (
        <button
          type="button"
          className="btn btn-primary btn-lg btn-lg-fit"
          onClick={onSubmit}
          disabled={!canProceed || isSubmitting}
        >
          {isSubmitting ? "Creating..." : "Create Firm"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-lg btn-lg-fit"
          onClick={onNext}
          disabled={!canProceed}
        >
          Continue
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Step 1: Firm Type
// ============================================================================

interface FirmTypeStepProps {
  selectedType: string;
  onSelect: (type: string) => void;
}

function FirmTypeStep({ selectedType, onSelect }: FirmTypeStepProps) {
  return (
    <div className="modal-option-grid">
      {ORGANIZATION_TYPES.map((type) => {
        const isSelected = selectedType === type.id;
        const className = `modal-option-card${isSelected ? " selected" : ""}`;

        return (
          <button
            key={type.id}
            type="button"
            className={className}
            onClick={() => onSelect(type.id)}
          >
            {type.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// Step 2: Basic Information
// ============================================================================

interface BasicInfoStepProps {
  name: string;
  firmSize: string;
  onNameChange: (name: string) => void;
  onFirmSizeChange: (size: string) => void;
}

function BasicInfoStep({
  name,
  firmSize,
  onNameChange,
  onFirmSizeChange,
}: BasicInfoStepProps) {
  return (
    <>
      <div className="form-group">
        <label className="form-label" htmlFor="orgName">
          Firm Name
        </label>
        <input
          id="orgName"
          type="text"
          className="form-input"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Smith & Associates"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Firm Size</label>
        <div className="modal-option-grid">
          {FIRM_SIZES.map((size) => {
            const isSelected = firmSize === size.id;
            const className = `modal-size-card${isSelected ? " selected" : ""}`;

            return (
              <button
                key={size.id}
                type="button"
                className={className}
                onClick={() => onFirmSizeChange(size.id)}
              >
                <span className="text-callout">{size.label}</span>
                <br />
                <span className="text-footnote text-secondary">
                  {size.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Step 3: Jurisdictions
// ============================================================================

interface JurisdictionsStepProps {
  selectedJurisdictions: string[];
  onToggle: (state: string) => void;
}

function JurisdictionsStep({
  selectedJurisdictions,
  onToggle,
}: JurisdictionsStepProps) {
  return (
    <div className="modal-body-scroll">
      <div className="modal-checkbox-grid">
        {US_STATES.map((state) => {
          const isSelected = selectedJurisdictions.includes(state);
          const className = `modal-checkbox-item${isSelected ? " selected" : ""}`;

          return (
            <label key={state} className={className}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(state)}
                className="modal-checkbox-input"
              />
              <span className="text-subhead">{state}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Step 4: Practice Areas
// ============================================================================

interface PracticeAreasStepProps {
  selectedPracticeAreas: string[];
  onToggle: (areaId: string) => void;
}

function PracticeAreasStep({
  selectedPracticeAreas,
  onToggle,
}: PracticeAreasStepProps) {
  return (
    <div className="modal-body-scroll">
      <div className="modal-checkbox-grid-2col">
        {PRACTICE_AREAS.map((area) => {
          const isSelected = selectedPracticeAreas.includes(area.id);
          const className = `modal-checkbox-item${isSelected ? " selected" : ""}`;

          return (
            <label key={area.id} className={className}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(area.id)}
                className="modal-checkbox-input"
              />
              <span className="text-subhead">{area.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
