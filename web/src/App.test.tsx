import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("AIT Planning Optimizer import shell", () => {
  it("shows both local import paths and the privacy controls", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "AIT Planning Optimizer" })).toBeInTheDocument();
    expect(screen.getByText("Local processing only")).toBeInTheDocument();
    expect(screen.getByLabelText("Select a local .xlsx file")).toHaveAttribute(
      "accept",
      expect.stringContaining(".xlsx"),
    );
    expect(screen.getByRole("button", { name: "Load synthetic example" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear local data" })).toBeDisabled();
    expect(screen.getByText("No automatic browser storage")).toBeInTheDocument();
  });
});
