import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  title: "Forms/Button",
  component: Button,
  argTypes: {
    variant: { control: "select", options: ["primary", "danger", "outline"] },
    size: { control: "select", options: ["sm", "lg"] },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;
export default meta;

// A plain args-driven story — the shape `snap` needs. It varies variants
// through Storybook's ?args= URL, so the story has to pass them through.
export const Default: StoryObj<typeof meta> = {
  args: { variant: "primary", size: "sm", disabled: false },
};
