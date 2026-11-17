import { MichiMantine } from './content/page/mantine/MichiMantine';
import { FieldControl, type FieldControlProps } from './content/page/vendor-blocks/src/desk/blocks/catalog/interactive/FieldControl';

/**
 * A form field's control on the ask card (UserInputBanner), loaded on first
 * use so Mantine stays off the chat's boot path. The question above it is the
 * field's label, so the label is only read aloud; the card's compact size.
 * Dropdowns open on a layer outside the card, which clips its sliding track.
 */
export default function AskFieldControl(props: Omit<FieldControlProps, 'hideLabel' | 'size'>) {
  return (
    <MichiMantine layerOutside>
      <FieldControl {...props} hideLabel size="xs" />
    </MichiMantine>
  );
}
