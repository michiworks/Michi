import { CodeIcon } from '../../../icons';
import { navPageEvent } from '../../../../../state/appEvents';

/** A custom view runs a widget in a sandbox, which Michi does not run yet: the view says it is off. */
export function CustomView() {
  return (
    <div className="michi-db-off" role="status">
      <CodeIcon size="lg" aria-hidden="true" />
      <span className="michi-db-off__title">This view is a widget, and widgets are off</span>
      <button
        type="button"
        className="michi-db-off__link"
        onClick={() => navPageEvent.dispatch({ page: 'settings' })}
      >
        Settings
      </button>
    </div>
  );
}
