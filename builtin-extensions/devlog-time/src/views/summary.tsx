/** Hours per client over a range, as the extension's page. */
import '@devlog/ui/styles.css'
import '../ui/time.css'
import { mount } from '@devlog/ui'
import { Page } from '../ui/Page'
import { Summary } from '../ui/Summary'

mount(<Page>{({ canvases, today }) => <Summary canvases={canvases} today={today} />}</Page>)
