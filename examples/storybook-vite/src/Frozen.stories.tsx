import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frozen } from "./Frozen";

const meta = { title: "Forms/Frozen", component: Frozen } satisfies Meta<typeof Frozen>;
export default meta;

// Deliberately broken, and included on purpose.
//
// The custom `render` ignores incoming args, so every variant URL produces an
// identical render. This is the one failure mode measurement cannot detect on
// its own — the values look real, they just all describe the default state.
// `snap` notices that every variant measured identically and warns.
//
// Run `storysync snap --components Frozen` to see it fire.
export const Default: StoryObj<typeof meta> = {
  args: { variant: "a" },
  render: () => <Frozen variant="b" />,
};
