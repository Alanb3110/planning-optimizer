import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("AIT Planning Optimizer shell", () => {
  it("shows the local-only workbook entry points", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "AIT Planning Optimizer" })).toBeInTheDocument();
    expect(screen.getByText("Local processing only")).toBeInTheDocument();
    expect(screen.getByLabelText("Select a local .xlsx file")).toHaveAttribute(
      "accept",
      expect.stringContaining(".xlsx"),
    );
    expect(screen.getByRole("button", { name: "Load synthetic example" })).toBeInTheDocument();
  });

  it("marks the synthetic example as ready without parsing it", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" }));

    expect(screen.getByText("synthetic_project.xlsx")).toBeInTheDocument();
    expect(screen.getByText(/Synthetic example ready/)).toBeInTheDocument();
    expect(screen.getByText(/Parsing is not enabled yet/)).toBeInTheDocument();
  });
});
