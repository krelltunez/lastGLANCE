import type { LucideIcon } from 'lucide-react'
import {
  Activity, AirVent, AlarmClock, Apple, Archive, Armchair,
  Award, Baby, Backpack, Bath, Battery,
  Bed, Beer, Bell, BellRing, Bike, Bird, Book,
  Bookmark, Briefcase, Brush, Bug, Bus,
  Calendar, Cake, Car, Carrot, Cat, ChefHat, Clock,
  ClipboardList, Coffee, Cog, Compass, Construction,
  Cookie, CookingPot, Cpu, CreditCard, Crown,
  CupSoda, Diamond, Dog, Drill, Droplet, Droplets, Dumbbell,
  Egg, Fan, Fish, Flag, Flame, Flashlight, Flower, Flower2, Footprints,
  Fuel, Gauge, Gift, GlassWater, Glasses, Globe,
  GraduationCap, Hammer, HandHeart, Headphones, Heart, HeartPulse,
  Home, Hospital, Hotel, House, Hourglass,
  IceCream, Inbox, Joystick, Key, Keyboard, Lamp, Leaf,
  LifeBuoy, Lightbulb, Lock, Magnet, Mail, Map, Medal,
  Microwave, Microscope, Milk, Milestone, Monitor, Moon, Mountain, Music,
  Navigation, Network, Nut, Package, Paintbrush, Paintbrush2, PawPrint,
  PersonStanding, Phone, Pill, Pipette, Pizza, Plug, Podcast, Printer,
  Puzzle, Rabbit, Radio, Rainbow, Receipt, Recycle, Refrigerator,
  Rocket, Ruler, Sandwich, Scale, Scissors, Server,
  Settings2, Shield, ShieldCheck, Shirt, ShoppingBag, Shovel, ShowerHead,
  Siren, Skull, Smartphone, Snowflake, Sofa, Soup,
  Sparkle, Sparkles, Speaker, Sprout, Star, Stamp, Stethoscope,
  Sun, Sunrise, Sunset, Syringe, Tablet, Target, Telescope, Tent,
  TestTube, Thermometer, Ticket, Timer, Toilet, Toolbox, Tornado,
  Train, Trash2, TreeDeciduous, TreePalm, TreePine, Trophy, Truck,
  Turtle, Tv2, Umbrella, UserCheck, Users, UtensilsCrossed,
  Voicemail, Watch, Waves, Wind, Wine, Wrench, Zap,
  WashingMachine,
} from 'lucide-react'

export const ICON_REGISTRY: Record<string, LucideIcon> = {
  // Home & Cleaning
  Home, House, Hotel, Sofa, Armchair, Bed, Lamp, Fan,
  Bath, ShowerHead, Toilet, Sparkles, Sparkle, Brush,
  Paintbrush, Paintbrush2, WashingMachine, Shirt, Droplets, Droplet,
  Waves, Wind, Trash2, Recycle, AirVent, Construction,
  // Kitchen & Food
  ChefHat, UtensilsCrossed, CookingPot, Refrigerator, Microwave,
  Flame, Coffee, CupSoda, GlassWater, Milk, Beer, Wine, Soup,
  Pizza, Sandwich, Egg, Cookie, Cake, IceCream, Carrot, Apple, Scale,
  // Pets
  Dog, Cat, Fish, Bird, Rabbit, PawPrint, Bug, Turtle,
  // Vehicle & Transport
  Car, Truck, Bus, Bike, Train, Fuel, Gauge, Nut,
  // Garden & Outdoors
  Leaf, Sprout, TreePine, TreeDeciduous, TreePalm, Flower, Flower2,
  Shovel, Umbrella, Sun, Sunrise, Sunset, Moon, Mountain, Tent,
  Compass, Rainbow, Snowflake, Tornado,
  // Health & Body
  Heart, HeartPulse, Activity, Dumbbell, Stethoscope, Thermometer, Pill,
  Syringe, PersonStanding, Footprints, Hospital, HandHeart,
  // Tools & Maintenance
  Wrench, Hammer, Drill, Toolbox, Scissors, Zap, Ruler,
  Lightbulb, Plug, Battery, Cog, Settings2,
  Magnet, Server, Printer,
  // Tech & Media
  Monitor, Tv2, Smartphone, Tablet, Headphones, Speaker, Keyboard,
  Music, Radio, Podcast, Network, Joystick, Cpu,
  // Lifestyle & Tracking
  Calendar, AlarmClock, Clock, Timer, Hourglass, Star, Flag, Target,
  Bookmark, ClipboardList, Receipt, Ticket, Milestone,
  Globe, Map, Navigation,
  Book, Archive, Inbox, Mail, Phone, Voicemail,
  Gift, Trophy, Medal, Award, Crown, Diamond,
  Baby, GraduationCap, Briefcase, Backpack, Package, ShoppingBag,
  Lock, Key, Shield, ShieldCheck,
  Users, UserCheck,
  Glasses, Watch, Skull, Siren, Flashlight, LifeBuoy,
  CreditCard, Rocket, Telescope, Microscope, TestTube, Pipette, Puzzle,
  Bell, BellRing, Stamp,
}

export const ICON_NAMES = Object.keys(ICON_REGISTRY)
