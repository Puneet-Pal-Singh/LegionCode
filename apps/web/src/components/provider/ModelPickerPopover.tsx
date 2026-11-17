import {
  ModelPickerPopover as SharedModelPickerPopover,
  type ModelPickerPopoverProps as SharedModelPickerPopoverProps,
} from "@legioncode/client-ui";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();
export type ModelPickerPopoverProps = Omit<
  SharedModelPickerPopoverProps,
  "policy"
>;

export function ModelPickerPopover(props: ModelPickerPopoverProps) {
  return <SharedModelPickerPopover {...props} policy={WEB_PROVIDER_POLICY} />;
}
