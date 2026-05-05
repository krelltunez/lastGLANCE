import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// All exported icon components, deduplicated by reference
const _seen = new Set<unknown>()
export const ICON_REGISTRY: Record<string, LucideIcon> = Object.fromEntries(
  Object.entries(LucideIcons).filter(([name, val]) => {
    if (
      name.endsWith('Icon') ||
      name === 'createLucideIcon' ||
      val === null ||
      typeof val !== 'object' ||
      !('$$typeof' in (val as object))
    ) return false
    if (_seen.has(val)) return false
    _seen.add(val)
    return true
  })
) as Record<string, LucideIcon>

export const ICON_NAMES = Object.keys(ICON_REGISTRY).sort()

// ── Categories ────────────────────────────────────────────────────────────────

export interface IconGroup {
  label: string
  icons: string[]
}

const ALL_GROUPS: IconGroup[] = [
  {
    label: 'Accessibility',
    icons: [
      'Accessibility', 'ALargeSmall', 'AArrowDown', 'AArrowUp',
      'Braille', 'Captions', 'Ear', 'EarOff',
      'Eye', 'EyeOff', 'EyeClosed', 'ScanEye',
      'HandBraille', 'PersonStanding', 'Wheelchair',
    ],
  },
  {
    label: 'Animals',
    icons: [
      'Bird', 'Bug', 'BugOff', 'Cat', 'Dog', 'Egg', 'EggOff', 'EggFried',
      'Feather', 'Fish', 'FishOff', 'FishSymbol',
      'PawPrint', 'Rabbit', 'Rat', 'Shell', 'Shrimp', 'Snail', 'Squirrel', 'Turtle', 'Worm',
    ],
  },
  {
    label: 'Arrows',
    icons: [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'ArrowUpLeft', 'ArrowUpRight', 'ArrowDownLeft', 'ArrowDownRight',
      'ArrowLeftRight', 'ArrowUpDown',
      'ArrowBigUp', 'ArrowBigDown', 'ArrowBigLeft', 'ArrowBigRight',
      'ArrowBigUpDash', 'ArrowBigDownDash', 'ArrowBigLeftDash', 'ArrowBigRightDash',
      'ArrowUpFromLine', 'ArrowDownFromLine', 'ArrowLeftFromLine', 'ArrowRightFromLine',
      'ArrowUpToLine', 'ArrowDownToLine', 'ArrowLeftToLine', 'ArrowRightToLine',
      'ArrowUpNarrowWide', 'ArrowDownNarrowWide', 'ArrowUpWideNarrow', 'ArrowDownWideNarrow',
      'ChevronUp', 'ChevronDown', 'ChevronLeft', 'ChevronRight',
      'ChevronFirst', 'ChevronLast',
      'ChevronsUp', 'ChevronsDown', 'ChevronsLeft', 'ChevronsRight',
      'ChevronsUpDown', 'ChevronsLeftRight',
      'CornerDownLeft', 'CornerDownRight', 'CornerLeftDown', 'CornerLeftUp',
      'CornerRightDown', 'CornerRightUp', 'CornerUpLeft', 'CornerUpRight',
      'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight',
      'MoveUpLeft', 'MoveUpRight', 'MoveDownLeft', 'MoveDownRight',
      'MoveHorizontal', 'MoveVertical', 'Move', 'Move3D',
      'CircleArrowUp', 'CircleArrowDown', 'CircleArrowLeft', 'CircleArrowRight',
      'SquareArrowUp', 'SquareArrowDown', 'SquareArrowLeft', 'SquareArrowRight',
      'Undo', 'Undo2', 'Redo', 'Redo2',
      'RotateCcw', 'RotateCw', 'RotateCcwSquare', 'RotateCwSquare',
      'RefreshCw', 'RefreshCcw', 'RefreshCwOff', 'RefreshCcwDot',
      'Repeat', 'Repeat1', 'Repeat2',
      'Shuffle', 'ArrowRightLeft',
      'TrendingUp', 'TrendingDown', 'TrendingUpDown',
    ],
  },
  {
    label: 'Buildings & Places',
    icons: [
      'Building', 'Building2', 'Castle', 'Church', 'Factory', 'Fence',
      'Home', 'House', 'HousePlug', 'HousePlus',
      'Hospital', 'Hotel', 'Landmark', 'School', 'School2',
      'Store', 'Warehouse', 'Tent', 'TentTree',
      'TreeDeciduous', 'TreePine', 'TreePalm', 'Trees',
    ],
  },
  {
    label: 'Charts & Data',
    icons: [
      'BarChart', 'BarChart2', 'BarChart3', 'BarChart4', 'BarChartBig',
      'BarChartHorizontal', 'BarChartHorizontalBig',
      'ChartBar', 'ChartBarBig', 'ChartBarDecreasing', 'ChartBarIncreasing', 'ChartBarStacked',
      'ChartCandlestick', 'ChartColumn', 'ChartColumnBig', 'ChartColumnDecreasing',
      'ChartColumnIncreasing', 'ChartColumnStacked',
      'ChartGantt', 'ChartLine', 'ChartNetwork',
      'ChartNoAxesColumn', 'ChartNoAxesColumnDecreasing', 'ChartNoAxesColumnIncreasing',
      'ChartNoAxesCombined', 'ChartNoAxesGantt',
      'ChartPie', 'ChartScatter', 'ChartSpline',
      'LineChart', 'AreaChart', 'PieChart', 'ScatterChart', 'CandlestickChart',
      'Activity', 'ActivitySquare',
      'Gauge', 'Signal', 'SignalHigh', 'SignalLow', 'SignalMedium', 'SignalZero',
      'Database', 'DatabaseBackup', 'DatabaseZap',
      'Table', 'Table2', 'TableCellsMerge', 'TableCellsSplit', 'TableProperties',
      'Network', 'Waypoints', 'GitGraph',
    ],
  },
  {
    label: 'Coding & Development',
    icons: [
      'Code', 'Code2', 'CodeXml', 'CodeSquare',
      'Terminal', 'TerminalSquare',
      'Bug', 'BugOff', 'BugPlay',
      'Braces', 'Brackets',
      'GitBranch', 'GitBranchPlus', 'GitCommit', 'GitCommitHorizontal', 'GitCommitVertical',
      'GitCompare', 'GitCompareArrows', 'GitFork', 'GitGraph', 'GitMerge',
      'GitPullRequest', 'GitPullRequestArrow', 'GitPullRequestClosed', 'GitPullRequestCreate',
      'GitPullRequestCreateArrow', 'GitPullRequestDraft',
      'Command', 'Regex', 'Variable', 'Function',
      'Cpu', 'Server', 'ServerCog', 'ServerCrash', 'ServerOff',
      'Webhook', 'Bot', 'BotMessageSquare', 'BotOff', 'Blocks',
    ],
  },
  {
    label: 'Communication',
    icons: [
      'Mail', 'MailCheck', 'MailMinus', 'MailOpen', 'MailPlus', 'MailQuestion',
      'MailSearch', 'MailWarning', 'MailX', 'Mails',
      'MessageCircle', 'MessageCircleCode', 'MessageCircleDashed', 'MessageCircleHeart',
      'MessageCircleMore', 'MessageCircleOff', 'MessageCirclePlus', 'MessageCircleQuestion',
      'MessageCircleReply', 'MessageCircleWarning', 'MessageCircleX',
      'MessageSquare', 'MessageSquareCode', 'MessageSquareDashed', 'MessageSquareDiff',
      'MessageSquareDot', 'MessageSquareHeart', 'MessageSquareMore', 'MessageSquareOff',
      'MessageSquarePlus', 'MessageSquareQuote', 'MessageSquareReply',
      'MessageSquareShare', 'MessageSquareText', 'MessageSquareWarning', 'MessageSquareX',
      'Messages', 'MessagesSquare',
      'Phone', 'PhoneCall', 'PhoneForwarded', 'PhoneIncoming', 'PhoneMissed',
      'PhoneOff', 'PhoneOutgoing',
      'Voicemail', 'Inbox', 'Send', 'SendHorizontal', 'Reply', 'ReplyAll', 'Forward',
      'AtSign', 'Hash', 'Megaphone', 'MegaphoneOff',
      'Mic', 'MicOff', 'MicVocal',
      'Bell', 'BellDot', 'BellElectric', 'BellMinus', 'BellOff', 'BellPlus', 'BellRing',
    ],
  },
  {
    label: 'Connectivity',
    icons: [
      'Wifi', 'WifiHigh', 'WifiLow', 'WifiOff', 'WifiZero',
      'Bluetooth', 'BluetoothConnected', 'BluetoothOff', 'BluetoothSearching',
      'Nfc', 'Rss',
      'Satellite', 'SatelliteDish',
      'Usb', 'Plug', 'PlugZap', 'Unplug',
      'Globe', 'Globe2', 'GlobeLock',
      'Cloud', 'CloudDownload', 'CloudUpload', 'CloudOff',
      'Network', 'Router',
    ],
  },
  {
    label: 'Design & Creativity',
    icons: [
      'Pen', 'PenLine', 'PenOff', 'PenTool',
      'Pencil', 'PencilLine', 'PencilOff', 'PencilRuler',
      'Paintbrush', 'Paintbrush2', 'PaintbrushVertical',
      'Brush', 'Pipette', 'Palette',
      'Eraser', 'Ruler', 'Scissors', 'ScissorsLineDashed',
      'Crop', 'Frame', 'Focus', 'ScanLine',
      'Spline', 'Layers', 'Layers2', 'Layers3',
      'Wand', 'Wand2', 'WandSparkles',
      'Image', 'Images', 'ImageDown', 'ImageMinus', 'ImageOff', 'ImagePlus', 'ImageUp', 'ImageUpscale',
      'Scan', 'ScanBarcode', 'ScanEye', 'ScanFace', 'ScanQrCode', 'ScanSearch', 'ScanText',
    ],
  },
  {
    label: 'Devices',
    icons: [
      'Monitor', 'MonitorCheck', 'MonitorDot', 'MonitorDown', 'MonitorOff',
      'MonitorPause', 'MonitorPlay', 'MonitorSmartphone', 'MonitorSpeaker',
      'MonitorStop', 'MonitorUp', 'MonitorX',
      'Laptop', 'LaptopMinimal', 'LaptopMinimalCheck',
      'Smartphone', 'SmartphoneCharging', 'SmartphoneNfc',
      'Tablet', 'TabletSmartphone',
      'Watch',
      'Tv', 'Tv2', 'TvMinimal', 'TvMinimalPlay',
      'Printer', 'PrinterCheck',
      'Keyboard', 'Mouse', 'MouseOff', 'MousePointer', 'MousePointer2', 'MousePointerClick',
      'Cpu', 'HardDrive', 'HardDriveDownload', 'HardDriveUpload', 'MemoryStick',
      'Headphones', 'Webcam', 'WebcamOff',
      'Gamepad', 'Gamepad2',
      'Camera', 'CameraOff', 'Video', 'VideoOff',
      'Speaker',
      'Battery', 'BatteryCharging', 'BatteryFull', 'BatteryLow', 'BatteryMedium', 'BatteryWarning',
    ],
  },
  {
    label: 'Emojis & Expressions',
    icons: [
      'Smile', 'SmilePlus', 'Laugh', 'Meh', 'Frown',
      'Angry', 'Ghost', 'Skull',
      'ThumbsUp', 'ThumbsDown',
      'Heart', 'HeartCrack', 'HeartHandshake', 'HeartOff', 'HeartPulse',
    ],
  },
  {
    label: 'Files & Folders',
    icons: [
      'File', 'FileArchive', 'FileAudio', 'FileAudio2', 'FileBadge', 'FileBadge2',
      'FileBarChart', 'FileBarChart2', 'FileBox', 'FileCheck', 'FileCheck2',
      'FileClock', 'FileCode', 'FileCode2', 'FileCog', 'FileDiff', 'FileDigit',
      'FileDown', 'FileHeart', 'FileImage', 'FileInput', 'FileJson', 'FileJson2',
      'FileKey', 'FileKey2', 'FileLock', 'FileLock2', 'FileMinus', 'FileMinus2',
      'FileMusic', 'FileOutput', 'FilePen', 'FilePenLine',
      'FilePlus', 'FilePlus2', 'FileQuestion', 'FileScan', 'FileSearch', 'FileSearch2',
      'FileSliders', 'FileSpreadsheet', 'FileStack', 'FileSymlink', 'FileTerminal',
      'FileText', 'FileType', 'FileType2', 'FileUp', 'FileUser', 'FileVideo', 'FileVideo2',
      'FileVolume', 'FileVolume2', 'FileWarning', 'FileX', 'FileX2', 'Files',
      'Folder', 'FolderArchive', 'FolderCheck', 'FolderClock', 'FolderCode',
      'FolderCog', 'FolderDot', 'FolderDown', 'FolderGit', 'FolderGit2',
      'FolderHeart', 'FolderInput', 'FolderKanban', 'FolderKey', 'FolderLock',
      'FolderMinus', 'FolderOpen', 'FolderOpenDot', 'FolderOutput', 'FolderPen',
      'FolderPlus', 'FolderRoot', 'FolderSearch', 'FolderSearch2', 'FolderSymlink',
      'FolderSync', 'FolderTree', 'FolderUp', 'FolderUser', 'FolderX', 'Folders',
      'Archive', 'ArchiveRestore', 'ArchiveX',
      'Paperclip', 'Paperclips',
    ],
  },
  {
    label: 'Finance & Money',
    icons: [
      'DollarSign', 'Euro', 'PoundSterling', 'JapaneseYen', 'IndianRupee',
      'SwissFranc', 'RussianRuble', 'Bitcoin',
      'BadgeDollarSign', 'BadgeCent', 'BadgeEuro', 'BadgePoundSterling',
      'BadgeRussianRuble', 'BadgeIndianRupee', 'BadgeJapaneseYen', 'BadgeSwissFranc',
      'CreditCard', 'Wallet', 'Wallet2', 'WalletCards', 'WalletMinimal',
      'Banknote', 'Coins', 'Gem', 'Diamond',
      'Receipt', 'ReceiptCent', 'ReceiptEuro', 'ReceiptIndianRupee', 'ReceiptJapaneseYen',
      'ReceiptPoundSterling', 'ReceiptRussianRuble', 'ReceiptSwissFranc', 'ReceiptText',
      'Percent', 'PiggyBank', 'HandCoins',
      'ShoppingCart', 'ShoppingBag', 'ShoppingBasket',
    ],
  },
  {
    label: 'Food & Drink',
    icons: [
      'Apple', 'Banana', 'Cherry', 'Grape', 'Lemon',
      'Beer', 'BeerOff', 'Wine', 'WineOff', 'Coffee',
      'CupSoda', 'GlassWater', 'Milk', 'MilkOff',
      'UtensilsCrossed', 'Utensils', 'ChefHat', 'CookingPot', 'Microwave', 'Refrigerator',
      'Pizza', 'Sandwich', 'Soup', 'Salad',
      'Egg', 'EggFried', 'EggOff',
      'Carrot', 'Cookie', 'Cake', 'CakeSlice', 'Candy', 'CandyOff', 'CandyCane',
      'IceCream', 'IceCream2',
      'Popcorn', 'Croissant', 'Drumstick', 'Nut', 'NutOff',
    ],
  },
  {
    label: 'Gaming',
    icons: [
      'Gamepad', 'Gamepad2', 'Joystick',
      'Dice1', 'Dice2', 'Dice3', 'Dice4', 'Dice5', 'Dice6',
      'Puzzle', 'Trophy', 'Medal', 'Award', 'Crown', 'Star', 'StarHalf', 'StarOff',
      'Sword', 'Swords', 'Shield', 'ShieldAlert', 'ShieldBan', 'ShieldCheck',
      'ShieldEllipsis', 'ShieldHalf', 'ShieldMinus', 'ShieldOff', 'ShieldPlus', 'ShieldX',
      'Target', 'Crosshair',
    ],
  },
  {
    label: 'Health & Medical',
    icons: [
      'Heart', 'HeartCrack', 'HeartHandshake', 'HeartOff', 'HeartPulse',
      'Activity', 'ActivitySquare',
      'Stethoscope', 'Thermometer', 'ThermometerSun', 'ThermometerSnowflake',
      'Pill', 'PillBottle', 'Syringe', 'Bandage',
      'Hospital', 'Ambulance', 'Cross',
      'Bone', 'Brain', 'Ear', 'Eye',
      'HandHeart', 'Dumbbell', 'PersonStanding', 'Footprints',
      'Scale', 'TestTube', 'TestTube2', 'Microscope',
      'FlaskConical', 'FlaskConicalOff', 'FlaskRound',
    ],
  },
  {
    label: 'Home & Furnishings',
    icons: [
      'Home', 'House', 'HousePlug', 'HousePlus',
      'Hotel', 'Sofa', 'Armchair', 'Bed', 'BedDouble', 'BedSingle',
      'Lamp', 'LampCeiling', 'LampDesk', 'LampFloor', 'LampWallDown', 'LampWallUp',
      'Fan', 'AirVent', 'Heater',
      'Bath', 'ShowerHead', 'Toilet',
      'Tv', 'Tv2', 'TvMinimal',
      'Microwave', 'Refrigerator', 'WashingMachine',
      'Lightbulb', 'LightbulbOff',
      'Mailbox', 'DoorClosed', 'DoorOpen', 'Fence',
    ],
  },
  {
    label: 'Layout & UI',
    icons: [
      'Layout', 'LayoutDashboard', 'LayoutGrid', 'LayoutList', 'LayoutPanelLeft',
      'LayoutPanelTop', 'LayoutTemplate',
      'Grid2X2', 'Grid3X3',
      'Columns2', 'Columns3', 'Columns4', 'Rows2', 'Rows3', 'Rows4',
      'Sidebar', 'SidebarClose', 'SidebarOpen',
      'PanelBottom', 'PanelBottomClose', 'PanelBottomDashed', 'PanelBottomOpen',
      'PanelLeft', 'PanelLeftClose', 'PanelLeftDashed', 'PanelLeftOpen',
      'PanelRight', 'PanelRightClose', 'PanelRightDashed', 'PanelRightOpen',
      'PanelTop', 'PanelTopClose', 'PanelTopDashed', 'PanelTopOpen',
      'Maximize', 'Maximize2', 'Minimize', 'Minimize2',
      'Expand', 'Shrink', 'AppWindow', 'AppWindowMac',
      'GalleryHorizontal', 'GalleryHorizontalEnd', 'GalleryThumbnails',
      'GalleryVertical', 'GalleryVerticalEnd',
      'Table', 'Table2',
    ],
  },
  {
    label: 'Maps & Navigation',
    icons: [
      'Map', 'MapPin', 'MapPinCheck', 'MapPinCheckInside', 'MapPinMinusInside',
      'MapPinOff', 'MapPinPlus', 'MapPinPlusInside', 'MapPinX', 'MapPinXInside',
      'MapPinned', 'MapPlus',
      'Navigation', 'Navigation2', 'NavigationOff',
      'Compass', 'Globe', 'Globe2', 'GlobeLock',
      'Route', 'RouteOff',
      'Milestone', 'Signpost', 'SignpostBig',
      'Radar', 'Crosshair', 'Telescope',
      'Mountain', 'MountainSnow', 'Waypoints',
    ],
  },
  {
    label: 'Math',
    icons: [
      'Plus', 'Minus', 'X', 'Divide',
      'CirclePlus', 'CircleMinus', 'CircleX',
      'SquarePlus', 'SquareMinus', 'SquareX',
      'Equal', 'NotEqual', 'Percent',
      'Pi', 'Infinity', 'Hash', 'Sigma',
      'Calculator', 'Superscript', 'Subscript',
      'Radical', 'Variable', 'Binary', 'Delta',
    ],
  },
  {
    label: 'Media & Playback',
    icons: [
      'Play', 'Pause', 'Square', 'CirclePlay', 'CirclePause', 'CircleStop',
      'SkipForward', 'SkipBack', 'FastForward', 'Rewind',
      'StepForward', 'StepBack', 'ChevronFirst', 'ChevronLast',
      'Volume', 'Volume1', 'Volume2', 'VolumeOff', 'VolumeX',
      'Music', 'Music2', 'Music3', 'Music4',
      'Headphones', 'Mic', 'MicOff', 'MicVocal',
      'Radio', 'Airplay', 'Cast', 'Podcast',
      'Film', 'Clapperboard', 'Projector',
      'Video', 'VideoOff', 'Camera', 'CameraOff',
      'Image', 'Images', 'ImagePlay',
      'Tv', 'Tv2', 'TvMinimal', 'TvMinimalPlay',
      'Album', 'Disc', 'Disc2', 'Disc3',
      'ListMusic', 'ListVideo',
    ],
  },
  {
    label: 'Nature & Weather',
    icons: [
      'Leaf', 'LeafyGreen', 'Sprout', 'Flower', 'Flower2',
      'TreeDeciduous', 'TreePine', 'TreePalm', 'Trees',
      'Sun', 'SunDim', 'SunMedium', 'SunSnow', 'Sunrise', 'Sunset',
      'Moon', 'MoonStar',
      'Cloud', 'CloudDrizzle', 'CloudFog', 'CloudHail', 'CloudLightning',
      'CloudMoon', 'CloudMoonRain', 'CloudOff', 'CloudRain', 'CloudRainWind',
      'CloudSnow', 'CloudSun', 'CloudSunRain',
      'Rainbow', 'Snowflake', 'Wind', 'Tornado', 'Waves',
      'Droplet', 'Droplets', 'Thermometer',
      'Flame', 'FlameKindling', 'Clover',
    ],
  },
  {
    label: 'People & Social',
    icons: [
      'User', 'UserCheck', 'UserCog', 'UserMinus', 'UserPen', 'UserPlus',
      'UserRound', 'UserRoundCheck', 'UserRoundCog', 'UserRoundMinus', 'UserRoundPen',
      'UserRoundPlus', 'UserRoundSearch', 'UserRoundX',
      'UserSearch', 'UserX',
      'Users', 'UsersRound',
      'PersonStanding', 'Baby',
      'Contact', 'ContactRound', 'IdCard',
      'Hand', 'Handshake', 'HandHeart', 'HandCoins', 'HandHelping', 'HandMetal',
      'GraduationCap', 'Briefcase', 'BriefcaseBusiness', 'BriefcaseMedical',
      'Badge', 'BadgeAlert', 'BadgeCheck', 'BadgeHelp', 'BadgeInfo',
      'BadgeMinus', 'BadgePlus', 'BadgePercent', 'BadgeX',
      'Group', 'Crown',
    ],
  },
  {
    label: 'Science & Research',
    icons: [
      'Microscope', 'Telescope', 'TestTube', 'TestTube2',
      'FlaskConical', 'FlaskConicalOff', 'FlaskRound',
      'Atom', 'Dna', 'Brain',
      'Sigma', 'Pi', 'Radical', 'Binary',
      'Magnet', 'Radiation', 'Biohazard', 'Orbit',
    ],
  },
  {
    label: 'Security',
    icons: [
      'Lock', 'LockKeyhole', 'LockOpen', 'UnlockKeyhole',
      'Key', 'KeyRound', 'KeySquare',
      'Shield', 'ShieldAlert', 'ShieldBan', 'ShieldCheck', 'ShieldEllipsis',
      'ShieldHalf', 'ShieldMinus', 'ShieldOff', 'ShieldPlus', 'ShieldQuestion', 'ShieldX',
      'Fingerprint', 'ScanFace',
      'Eye', 'EyeOff', 'EyeClosed',
      'AlertTriangle', 'AlertCircle', 'AlertOctagon',
      'Siren',
    ],
  },
  {
    label: 'Shapes',
    icons: [
      'Circle', 'CircleDashed', 'CircleDot', 'CircleDotDashed',
      'Square', 'SquareDashed', 'SquareDot',
      'Triangle', 'TriangleRight',
      'Hexagon', 'Pentagon', 'Octagon',
      'Diamond', 'Gem', 'Star', 'StarHalf', 'StarOff',
    ],
  },
  {
    label: 'Shopping',
    icons: [
      'ShoppingCart', 'ShoppingBag', 'ShoppingBasket',
      'Store', 'Package', 'Package2', 'PackageCheck', 'PackageMinus', 'PackageOpen',
      'PackagePlus', 'PackageSearch', 'PackageX', 'Packages',
      'Tag', 'Tags', 'Barcode', 'ScanBarcode', 'ScanQrCode',
      'Gift', 'Ticket', 'TicketCheck', 'TicketMinus', 'TicketPercent',
      'TicketPlus', 'TicketSlash', 'TicketX',
      'Receipt', 'Stamp',
    ],
  },
  {
    label: 'Sports & Fitness',
    icons: [
      'Dumbbell', 'Bike', 'PersonStanding', 'Footprints',
      'Trophy', 'Medal', 'Award', 'Sword', 'Swords', 'Target',
      'Heart', 'HeartPulse', 'Activity',
    ],
  },
  {
    label: 'Text & Typography',
    icons: [
      'Bold', 'Italic', 'Underline', 'Strikethrough',
      'AlignLeft', 'AlignCenter', 'AlignRight', 'AlignJustify',
      'List', 'ListChecks', 'ListCollapse', 'ListEnd', 'ListFilter', 'ListMinus',
      'ListMusic', 'ListOrdered', 'ListPlus', 'ListRestart', 'ListStart',
      'ListTodo', 'ListTree', 'ListVideo', 'ListX',
      'IndentDecrease', 'IndentIncrease', 'WrapText',
      'Pilcrow', 'PilcrowLeft', 'PilcrowRight',
      'Quote', 'RemoveFormatting',
      'Type', 'TypeOutline', 'Subscript', 'Superscript',
      'SpellCheck', 'SpellCheck2',
      'Heading', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6',
      'ALargeSmall', 'AArrowDown', 'AArrowUp',
      'CaseLower', 'CaseSensitive', 'CaseUpper',
      'Baseline', 'TextCursorInput', 'TextCursor', 'Text',
    ],
  },
  {
    label: 'Time & Calendar',
    icons: [
      'Clock', 'Clock1', 'Clock2', 'Clock3', 'Clock4', 'Clock5', 'Clock6',
      'Clock7', 'Clock8', 'Clock9', 'Clock10', 'Clock11', 'Clock12',
      'AlarmClock', 'AlarmClockCheck', 'AlarmClockMinus', 'AlarmClockOff', 'AlarmClockPlus',
      'AlarmCheck', 'AlarmMinus', 'AlarmPlus', 'AlarmSmoke',
      'Calendar', 'CalendarArrowDown', 'CalendarArrowUp', 'CalendarCheck', 'CalendarCheck2',
      'CalendarClock', 'CalendarCog', 'CalendarDays', 'CalendarFold', 'CalendarHeart',
      'CalendarMinus', 'CalendarMinus2', 'CalendarOff', 'CalendarPlus', 'CalendarPlus2',
      'CalendarRange', 'CalendarSearch', 'CalendarSync', 'CalendarX', 'CalendarX2',
      'Timer', 'TimerOff', 'TimerReset',
      'Hourglass', 'Watch', 'History',
    ],
  },
  {
    label: 'Tools & Settings',
    icons: [
      'Wrench', 'Hammer', 'Drill', 'Scissors', 'ScissorsLineDashed',
      'Ruler', 'Shovel', 'Pickaxe', 'Axe', 'Toolbox', 'Construction',
      'Settings', 'Settings2', 'Cog', 'SlidersHorizontal', 'SlidersVertical',
      'ToggleLeft', 'ToggleRight',
      'Zap', 'ZapOff', 'Lightbulb', 'LightbulbOff',
      'Plug', 'PlugZap', 'Unplug',
      'Nut', 'NutOff', 'Magnet', 'Paperclip', 'Link', 'Link2', 'Link2Off',
      'Clipboard', 'ClipboardCheck', 'ClipboardCopy', 'ClipboardList', 'ClipboardMinus',
      'ClipboardPen', 'ClipboardPenLine', 'ClipboardPlus', 'ClipboardType', 'ClipboardX',
    ],
  },
  {
    label: 'Transportation',
    icons: [
      'Car', 'CarFront', 'CarTaxiFront',
      'Truck', 'Bus', 'BusFront',
      'Bike', 'Train', 'TrainFront', 'TrainTrack',
      'Plane', 'PlaneLanding', 'PlaneTakeoff',
      'Ship', 'Sailboat', 'Anchor',
      'Fuel', 'Gauge', 'Helicopter', 'Cable', 'CableCar',
      'Forklift', 'Tractor', 'Caravan',
    ],
  },
  {
    label: 'Travel',
    icons: [
      'Plane', 'PlaneLanding', 'PlaneTakeoff',
      'Hotel', 'Tent', 'TentTree',
      'Backpack', 'Luggage', 'BriefcaseBusiness',
      'Map', 'Globe', 'Globe2', 'GlobeLock',
      'Compass', 'Navigation', 'Navigation2',
      'Milestone', 'Signpost', 'Route',
      'Mountain', 'MountainSnow',
      'CableCar', 'Anchor', 'Ship', 'Sailboat', 'Ticket',
    ],
  },
]

// Filter each group to icons that exist in the installed package
export const ICON_GROUPS: IconGroup[] = ALL_GROUPS
  .map(group => ({
    label: group.label,
    icons: group.icons.filter(name => name in ICON_REGISTRY),
  }))
  .filter(group => group.icons.length > 0)

// Catch-all: icons not assigned to any named group
const assignedNames = new Set(ALL_GROUPS.flatMap(g => g.icons))
const ungrouped = ICON_NAMES.filter(name => !assignedNames.has(name))
if (ungrouped.length > 0) {
  ICON_GROUPS.push({ label: 'Other', icons: ungrouped })
}
