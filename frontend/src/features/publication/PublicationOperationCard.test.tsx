import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { publicationOperationFixture } from "../../test/fixtures";
import { PublicationOperationCard } from "./PublicationOperationCard";

afterEach(cleanup);

describe("PublicationOperationCard", () => {
  it("renders inspector rows with mono uuid, badge and sync-lock note", () => {
    render(
      <ul>
        <PublicationOperationCard
          operation={publicationOperationFixture({ status: "succeeded" }) as Parameters<typeof PublicationOperationCard>[0]["operation"]}
        />
      </ul>,
    );

    expect(screen.getByText("Operation UUID")).toBeInTheDocument();
    expect(screen.getByText("operation-1").className).toMatch(/mono/);
    expect(screen.getByText("Attempt (zero-retry)")).toBeInTheDocument();
    expect(screen.getByText("Target version")).toBeInTheDocument();
    const badge = screen.getByText("Succeeded");
    expect(badge).toHaveAttribute("data-status", "succeeded");
    expect(screen.getByText(/Keitaro Sync Lock/)).toBeInTheDocument();
  });
});
