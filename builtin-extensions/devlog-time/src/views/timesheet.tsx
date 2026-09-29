/** The weekly timesheet, as the extension's page. */
import '@devlog/ui/styles.css'
import '../ui/time.css'
import { mount } from '@devlog/ui'
import { Page } from '../ui/Page'
import { Timesheet } from '../ui/Timesheet'

mount(<Page>{(p) => <Timesheet {...p} />}</Page>)
